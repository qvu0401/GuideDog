// public/app.js

const video = document.getElementById("video");
const canvas = document.getElementById("canvas");
const btnCapture = document.getElementById("btnCapture");
const statusEl = document.getElementById("status");

let stream = null;
let busy = false;

// Auto-repeat mode
let autoRepeatOn = false;
let autoTimer = null;
const AUTO_INTERVAL_MS = 2500;

// Click vs double-click handling
let clickTimer = null;
const DOUBLE_CLICK_WINDOW_MS = 260;

// Long press handling
const LONG_PRESS_MS = 650;
let longPressTimer = null;
let longPressTriggered = false;

// Auto-repeat: last state key
let lastAutoKey = null;

// One-time spoken intro (must happen after user gesture)
let introSpoken = false;

let introJustPlayed = false;

// ---------- UI ----------
function setStatus(text) {
  statusEl.textContent = text;
}

// ---------- Haptics ----------
function vibrate(pattern) {
  if (!("vibrate" in navigator)) return;
  navigator.vibrate(pattern);
}

// ---------- Speech queue (no overlap) ----------
let speechChain = Promise.resolve();

function speakQueued(text) {
  if (!("speechSynthesis" in window)) return Promise.resolve();
  speechChain = speechChain.then(() => speakOnce(text)).catch(() => {});
  return speechChain;
}

function speakOnce(text) {
  return new Promise((resolve) => {
    try {
      const u = new SpeechSynthesisUtterance(text);
      u.rate = 1.0;
      u.pitch = 1.0;
      u.volume = 1.0;
      u.onend = () => resolve();
      u.onerror = () => resolve();
      window.speechSynthesis.speak(u);
    } catch {
      resolve();
    }
  });
}

async function speakIntroOnce() {
  if (introSpoken) return false;

  introSpoken = true;
  introJustPlayed = true;

  await speakQueued(
    "Single tap to detect people. Double tap to auto repeat. Press and hold for a more detailed analysis of the person."
  );

  return true;
}


// ---------- Camera ----------
async function ensureCamera() {
  if (stream) return;

  setStatus("Requesting camera permission…");
  stream = await navigator.mediaDevices.getUserMedia({
    video: {
      facingMode: "environment",
      width: { ideal: 640 },
      height: { ideal: 480 },
    },
    audio: false,
  });

  video.srcObject = stream;

  await new Promise((resolve) => {
    video.onloadedmetadata = () => resolve();
  });

  setStatus(
    "Ready. Single tap: detect. Double tap: auto-repeat. Press and hold: detailed."
  );
}

function captureFrameBlob() {
  const w = video.videoWidth;
  const h = video.videoHeight;
  if (!w || !h) throw new Error("Camera not ready yet.");

  const MAX_W = 640;
  const scale = Math.min(1, MAX_W / w);

  canvas.width = Math.round(w * scale);
  canvas.height = Math.round(h * scale);

  const ctx = canvas.getContext("2d", { alpha: false });
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("Failed to capture photo."))),
      "image/jpeg",
      0.82
    );
  });
}

// ---------- Server inference ----------
async function inferWithEyePop(imageBlob, mode) {
  const form = new FormData();
  form.append("file", imageBlob, "photo.jpg");

  const resp = await fetch(`/api/infer?mode=${encodeURIComponent(mode)}`, {
    method: "POST",
    body: form,
  });

  const payload = await resp.json();
  if (!resp.ok) throw new Error(payload?.error || "Inference failed");
  return payload;
}

// ---------- Parsing ----------
function analyzePeopleFromServer(payload) {
  const people = Array.isArray(payload?.people) ? payload.people : [];
  const count = people.length;
  const best = people[0] || null;
  return { count, best, people };
}

function nicePosition(best) {
  const p = String(best?.position || "").toLowerCase();
  if (p === "left" || p === "right" || p === "center") return p;
  return "center";
}

function niceGender(best) {
  if (!best?.gender) return null;
  const g = String(best.gender).toLowerCase().trim();
  if (g === "male") return "male";
  if (g === "female") return "female";
  return null;
}

function niceActivity(best) {
  if (!best?.activity) return null;
  const a = String(best.activity).toLowerCase().trim();
  const known = [
    "walking",
    "running",
    "sitting",
    "standing",
    "exercising",
    "eating",
    "talking",
    "working",
    "playing",
    "other",
  ];
  return known.find((k) => a === k || a.includes(k)) || null;
}

// ---------- Messages ----------
function messageDetect(count, best) {
  if (count === 0) {
    return {
      text: "No people detected where your camera is pointed. If you're unsure, take another photo.",
      vib: [40, 60, 40],
    };
  }

  const pos = nicePosition(best);

  if (count === 1) {
    return {
      text: `Be careful. One person on the ${pos}.`,
      vib: [25, 40, 25],
    };
  }

  const plural = count === 2 ? "two people" : `${count} people`;
  return {
    text: `Be careful. I see ${plural} ahead. Closest person on the ${pos}.`,
    vib: [30, 80, 30],
  };
}

function messageDetailed(count, best) {
  if (count === 0) {
    return {
      text: "Detailed: no people detected in this photo.",
      vib: [40, 60, 40],
    };
  }

  const pos = nicePosition(best);
  const gender = niceGender(best);
  const activity = niceActivity(best);

  const parts = [];

  if (count === 1) parts.push("Detailed: I see one person.");
  else if (count === 2) parts.push("Detailed: I see two people.");
  else parts.push(`Detailed: I see ${count} people.`);

  if (activity) parts.push(`They seem to be ${activity}.`);
  if (gender) parts.push(`They seem to be ${gender}.`);
  if (!activity && !gender) parts.push("I'm not sure about their activity or gender.");

  parts.push(`Closest person is on the ${pos}.`);

  return { text: parts.join(" "), vib: [25, 40, 25] };
}

// Auto-repeat bucket for count + best position
function autoBucketForCount(count) {
  if (count <= 0) return "c0";
  if (count === 1) return "c1";
  if (count === 2) return "c2";
  return "c3plus";
}

function autoKey(count, best) {
  const bucket = autoBucketForCount(count);
  if (bucket === "c0") return bucket;
  const pos = nicePosition(best);
  return `${bucket}|${pos}`;
}

// ---------- Core actions ----------
async function doDetect({ auto = false } = {}) {
  if (busy) return;
  busy = true;

  try {
    await ensureCamera();

    setStatus(auto ? "Auto-repeat: capturing…" : "Taking photo…");
    vibrate(18);

    const blob = await captureFrameBlob();
    setStatus(auto ? "Auto-repeat: analyzing…" : "Analyzing…");

    const payload = await inferWithEyePop(blob, "detect");
    const { count, best } = analyzePeopleFromServer(payload);
    const msg = messageDetect(count, best);

    if (!auto) {
      await speakQueued(msg.text);
      vibrate(msg.vib);
      setStatus(`Done. ${count === 0 ? "No people detected." : `${count} people detected.`}`);
      return;
    }

    const key = autoKey(count, best);
    const changed = lastAutoKey === null || key !== lastAutoKey;
    lastAutoKey = key;

    setStatus(`Auto-repeat on. Last: ${count === 0 ? "no people" : `${count} people`}.`);

    if (changed) {
      await speakQueued(msg.text);
      vibrate(msg.vib);
    }
  } catch (err) {
    setStatus(`Error. ${err.message}`);

    if (!auto) {
      await speakQueued("Error. Please try again.");
      vibrate([60, 40, 60]);
    } else {
      const key = "error";
      const changed = lastAutoKey === null || key !== lastAutoKey;
      lastAutoKey = key;
      if (changed) {
        await speakQueued("Error. Please check your connection and try again.");
        vibrate([60, 40, 60]);
      }
    }
  } finally {
    busy = false;
  }
}

async function doDetailedVI() {
  if (busy) return;
  busy = true;

  try {
    await ensureCamera();

    setStatus("Capturing for detailed analysis…");
    vibrate([15, 25, 15]);

    await speakQueued("Detailed analysis. This can take a while. Please hold still.");

    const blob = await captureFrameBlob();
    setStatus("Detailed analysis in progress…");

    const payload = await inferWithEyePop(blob, "vi");
    const { count, best } = analyzePeopleFromServer(payload);

    const msg = messageDetailed(count, best);
    await speakQueued(msg.text);
    vibrate(msg.vib);
    setStatus("Detailed analysis done.");
  } catch (err) {
    setStatus(`Error. ${err.message}`);
    await speakQueued("Error during detailed analysis. Please try again.");
    vibrate([60, 40, 60]);
  } finally {
    busy = false;
  }
}

// ---------- Auto-repeat toggle ----------
async function enterAutoRepeat() {
  if (autoRepeatOn) return;
  autoRepeatOn = true;
  lastAutoKey = null;

  await ensureCamera();

  setStatus("Auto-repeat mode on.");
  await speakQueued(
    "Auto-repeat mode on. I will speak when the count or position changes. Double tap to exit."
  );
  vibrate([25, 40, 25]);

  autoTimer = setInterval(() => {
    if (!autoRepeatOn) return;
    doDetect({ auto: true });
  }, AUTO_INTERVAL_MS);

  doDetect({ auto: true });
}

async function exitAutoRepeat() {
  if (!autoRepeatOn) return;
  autoRepeatOn = false;
  if (autoTimer) clearInterval(autoTimer);
  autoTimer = null;

  setStatus("Auto-repeat mode off.");
  await speakQueued("Auto-repeat mode off.");
  vibrate([40, 30, 40]);
}

async function toggleAutoRepeat() {
  if (autoRepeatOn) await exitAutoRepeat();
  else await enterAutoRepeat();
}

// ---------- Long press wiring ----------
function startLongPress() {
  if (longPressTimer) clearTimeout(longPressTimer);
  longPressTriggered = false;

  longPressTimer = setTimeout(() => {
    longPressTriggered = true;
    doDetailedVI();
  }, LONG_PRESS_MS);
}

function cancelLongPress() {
  if (longPressTimer) clearTimeout(longPressTimer);
  longPressTimer = null;
}

// Speak intro on first gesture (pointerdown is best for mobile)
btnCapture.addEventListener("pointerdown", (e) => {
  e.preventDefault();
  speakIntroOnce();
  startLongPress();
});

btnCapture.addEventListener("pointerup", cancelLongPress);
btnCapture.addEventListener("pointercancel", cancelLongPress);
btnCapture.addEventListener("pointerleave", cancelLongPress);

// ---------- Single vs double click ----------
btnCapture.addEventListener("click", () => {
  if (longPressTriggered) {
    longPressTriggered = false;
    return;
  }

  // ⛔ First tap: intro only, no detection
  if (introJustPlayed) {
    introJustPlayed = false;
    return;
  }

  if (clickTimer) clearTimeout(clickTimer);
  clickTimer = setTimeout(() => {
    clickTimer = null;

    if (!autoRepeatOn) {
      doDetect({ auto: false });
    } else {
      speakQueued("Auto-repeat is on. Double tap to exit.");
    }
  }, DOUBLE_CLICK_WINDOW_MS);
});


btnCapture.addEventListener("dblclick", (e) => {
  e.preventDefault();
  if (!introSpoken) return;

  if (clickTimer) {
    clearTimeout(clickTimer);
    clickTimer = null;
  }
  toggleAutoRepeat();
});


// Initial UX (visual)
setStatus("Tap the big button to begin.");
