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

// Detection tuning
const PERSON_LABELS = new Set(["person", "people", "human"]);
const CONFIDENCE_THRESHOLD = 0.35;
const HIGH_CONF = 0.70;
const MED_CONF = 0.45;

// Auto-repeat: speak when bucketed count changes (0 / 1 / 2 / 3+)
let lastAutoKey = null;

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

      // Do NOT cancel; let it finish
      window.speechSynthesis.speak(u);
    } catch {
      resolve();
    }
  });
}

// ---------- Camera ----------
async function ensureCamera() {
  if (stream) return;

  setStatus("Requesting camera permission…");
  stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: "environment" },
    audio: false,
  });

  video.srcObject = stream;

  await new Promise((resolve) => {
    video.onloadedmetadata = () => resolve();
  });

  setStatus('Ready. Single tap: take photo. Double tap: auto-repeat.');
}

function captureFrameBlob() {
  const w = video.videoWidth;
  const h = video.videoHeight;
  if (!w || !h) throw new Error("Camera not ready yet.");

  canvas.width = w;
  canvas.height = h;

  const ctx = canvas.getContext("2d");
  ctx.drawImage(video, 0, 0, w, h);

  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("Failed to capture photo."))),
      "image/jpeg",
      0.92
    );
  });
}

// ---------- EyePop inference (via your server) ----------
async function inferWithEyePop(imageBlob) {
  const form = new FormData();
  form.append("file", imageBlob, "photo.jpg");

  const resp = await fetch("/api/infer", { method: "POST", body: form });
  const payload = await resp.json();

  if (!resp.ok) throw new Error(payload?.error || "Inference failed");
  return payload;
}

function normalizeObjects(payload) {
  if (payload && payload.best && Array.isArray(payload.best.objects)) return payload.best.objects;
  if (Array.isArray(payload) && payload[0]?.objects) return payload[0].objects;
  if (payload && Array.isArray(payload.objects)) return payload.objects;
  return [];
}

function analyzePeople(objects) {
  let count = 0;
  let bestConf = 0;

  for (const o of objects) {
    const label = String(o.classLabel || "").toLowerCase();
    const conf = Number(o.confidence || 0);

    if (PERSON_LABELS.has(label) && conf >= CONFIDENCE_THRESHOLD) {
      count += 1;
      if (conf > bestConf) bestConf = conf;
    }
  }

  return { count, bestConf };
}

function confidenceWord(bestConf) {
  if (bestConf >= HIGH_CONF) return "I see";
  if (bestConf >= MED_CONF) return "I likely see";
  return "I might see";
}

function messageFor(count, bestConf) {
  if (count === 0) {
    return {
      text: "No people detected where your camera is pointed. If you're unsure, take another photo.",
      vib: [40, 60, 40],
    };
  }

  const cw = confidenceWord(bestConf);

  if (count === 1) {
    return {
      text: `Be careful. ${cw} one person ahead where your camera is pointed.`,
      vib: [25, 40, 25],
    };
  }

  const plural = count === 2 ? "two people" : `${count} people`;
  return {
    text: `Be careful. ${cw} ${plural} ahead.`,
    vib: [30, 80, 30],
  };
}

// Bucket counts so the app speaks on meaningful changes
function autoKeyForCount(count) {
  if (count <= 0) return "c0";
  if (count === 1) return "c1";
  if (count === 2) return "c2";
  return "c3plus";
}

// ---------- Core action ----------
async function takeAndAnnounce({ auto = false } = {}) {
  if (busy) return;
  busy = true;

  try {
    await ensureCamera();

    setStatus(auto ? "Auto-repeat: capturing…" : "Taking photo…");
    vibrate(18);

    const blob = await captureFrameBlob();

    setStatus(auto ? "Auto-repeat: analyzing…" : "Analyzing…");
    const payload = await inferWithEyePop(blob);
    const objects = normalizeObjects(payload);

    const { count, bestConf } = analyzePeople(objects);
    const msg = messageFor(count, bestConf);

    if (!auto) {
      // Single-shot: always speak
      await speakQueued(msg.text);
      vibrate(msg.vib);
      setStatus(`Done. ${count === 0 ? "No people detected." : `${count} people detected.`}`);
      return;
    }

    // Auto-repeat: speak only when bucket changes
    const key = autoKeyForCount(count);
    const changed = lastAutoKey === null || key !== lastAutoKey;
    lastAutoKey = key;

    setStatus(`Auto-repeat on. Last: ${count === 0 ? "no people" : `${count} people`}.`);

    if (changed) {
      await speakQueued(msg.text);
      vibrate(msg.vib);
    }
  } catch (err) {
    setStatus(`Error. ${err.message}`);

    // In auto mode, only speak the first time we hit an "error bucket"
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

// ---------- Auto-repeat toggle ----------
async function enterAutoRepeat() {
  if (autoRepeatOn) return;
  autoRepeatOn = true;
  lastAutoKey = null; // reset so first result speaks

  await ensureCamera();

  setStatus("Auto-repeat mode on.");
  await speakQueued("Auto-repeat mode on. I will speak only when the number of people changes. Double tap to exit.");
  vibrate([25, 40, 25]);

  autoTimer = setInterval(() => {
    if (!autoRepeatOn) return;
    takeAndAnnounce({ auto: true });
  }, AUTO_INTERVAL_MS);

  // Run immediately
  takeAndAnnounce({ auto: true });
}

async function exitAutoRepeat() {
  if (!autoRepeatOn) return;
  autoRepeatOn = false;
  if (autoTimer) clearInterval(autoTimer);
  autoTimer = null;

  setStatus('Auto-repeat mode off.');
  await speakQueued("Auto-repeat mode off.");
  vibrate([40, 30, 40]);
}

async function toggleAutoRepeat() {
  if (autoRepeatOn) await exitAutoRepeat();
  else await enterAutoRepeat();
}

// ---------- One button: single vs double click ----------
btnCapture.addEventListener("click", () => {
  if (clickTimer) clearTimeout(clickTimer);
  clickTimer = setTimeout(() => {
    clickTimer = null;

    if (!autoRepeatOn) {
      takeAndAnnounce({ auto: false });
    } else {
      // Keep it simple in auto mode
      speakQueued("Auto-repeat is on. Double tap to exit.");
    }
  }, DOUBLE_CLICK_WINDOW_MS);
});

btnCapture.addEventListener("dblclick", (e) => {
  e.preventDefault();
  if (clickTimer) {
    clearTimeout(clickTimer);
    clickTimer = null;
  }
  toggleAutoRepeat();
});

// Initial UX
setStatus('Ready. Single tap: take photo. Double tap: auto-repeat.');
