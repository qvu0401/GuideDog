const video = document.getElementById("video");
const canvas = document.getElementById("canvas");
const btnCapture = document.getElementById("btnCapture");
const statusEl = document.getElementById("status");

let stream = null;
let busy = false;

// Many person-detection pops use "person"
const PERSON_LABELS = new Set(["person", "people", "human"]);

// ---------- UI ----------
function setStatus(text) {
  statusEl.textContent = text;
}

// ---------- Speech ----------
function speak(text) {
  if (!("speechSynthesis" in window)) return;
  window.speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.rate = 1.0;
  u.pitch = 1.0;
  u.volume = 1.0;
  window.speechSynthesis.speak(u);
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

  setStatus('Ready. Tap “Take photo”.');
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

// ---------- Server inference ----------
async function inferWithEyePop(imageBlob) {
  const form = new FormData();
  form.append("file", imageBlob, "photo.jpg");

  const resp = await fetch("/api/infer", { method: "POST", body: form });
  const payload = await resp.json();

  if (!resp.ok) throw new Error(payload?.error || "Inference failed");
  return payload;
}

// Normalize payload to objects array
function normalizeObjects(payload) {
  if (payload && payload.best && Array.isArray(payload.best.objects)) return payload.best.objects;
  if (Array.isArray(payload) && payload[0]?.objects) return payload[0].objects;
  if (payload && Array.isArray(payload.objects)) return payload.objects;
  return [];
}

// ---------- Bounding box parsing (for left/center/right) ----------
function getBox(obj) {
  const b = obj.box || obj.bbox || obj.boundingBox || obj.bounding_box || null;

  if (b && typeof b === "object") {
    // { x, y, width, height }
    if (isFinite(b.x) && isFinite(b.y) && isFinite(b.width) && isFinite(b.height)) {
      return { x: b.x, y: b.y, w: b.width, h: b.height, normalized: false };
    }
    // { left, top, right, bottom }
    if (isFinite(b.left) && isFinite(b.top) && isFinite(b.right) && isFinite(b.bottom)) {
      return { x: b.left, y: b.top, w: b.right - b.left, h: b.bottom - b.top, normalized: false };
    }
  }

  // normalized coords: { x, y, width, height } in 0..1
  const nb = obj.normalizedBox || obj.normalized_bbox || obj.normalizedBoundingBox || null;
  if (nb && typeof nb === "object") {
    if (isFinite(nb.x) && isFinite(nb.y) && isFinite(nb.width) && isFinite(nb.height)) {
      return { x: nb.x, y: nb.y, w: nb.width, h: nb.height, normalized: true };
    }
    if (isFinite(nb.left) && isFinite(nb.top) && isFinite(nb.right) && isFinite(nb.bottom)) {
      return { x: nb.left, y: nb.top, w: nb.right - nb.left, h: nb.bottom - nb.top, normalized: true };
    }
  }

  return null;
}

function toPixelBox(box, frameW, frameH) {
  if (!box) return null;
  if (box.normalized) {
    return { x: box.x * frameW, y: box.y * frameH, w: box.w * frameW, h: box.h * frameH };
  }
  return box;
}

function directionFromBox(pixelBox, frameW) {
  if (!pixelBox) return "unknown";
  const centerX = pixelBox.x + pixelBox.w / 2;
  const t = centerX / frameW;

  if (t < 0.40) return "left";
  if (t > 0.60) return "right";
  return "center";
}

// Pick most “salient” people first: bigger box area, else higher confidence
function sortPeople(people, frameW, frameH) {
  return people
    .map((p) => {
      const box = p.box ? toPixelBox(p.box, frameW, frameH) : null;
      const area = box ? Math.max(0, box.w) * Math.max(0, box.h) : 0;
      return { ...p, area };
    })
    .sort((a, b) => (b.area - a.area) || (b.conf - a.conf));
}

// ---------- Main: take photo -> describe ----------
async function takeAndDescribe() {
  if (busy) return;
  busy = true;
  btnCapture.disabled = true;

  try {
    // First tap requests camera permission if needed (required by browsers)
    await ensureCamera();

    setStatus("Taking photo…");
    const blob = await captureFrameBlob();

    setStatus("Analyzing…");
    const payload = await inferWithEyePop(blob);
    const objects = normalizeObjects(payload);

    const frameW = video.videoWidth || 1;
    const frameH = video.videoHeight || 1;

    const threshold = 0.35;

    // Filter people
    const people = objects
      .map((o) => ({
        label: String(o.classLabel || "").toLowerCase(),
        conf: Number(o.confidence || 0),
        box: getBox(o),
      }))
      .filter((d) => PERSON_LABELS.has(d.label) && d.conf >= threshold);

    if (people.length === 0) {
      const msg = "No person detected.";
      setStatus(msg);
      speak(msg);
      return;
    }

    const sorted = sortPeople(people, frameW, frameH);

    // Compute directions
    const dirs = sorted
      .slice(0, 3) // keep speech short
      .map((p) => directionFromBox(p.box ? toPixelBox(p.box, frameW, frameH) : null, frameW));

    // Build minimal accessible speech
    let msg = "";
    if (people.length === 1) {
      const dir = dirs[0] === "unknown" ? "ahead" : dirs[0];
      msg = `Person ahead, ${dir}.`;
    } else {
      // Count directions for a quick summary
      const counts = { left: 0, center: 0, right: 0, unknown: 0 };
      dirs.forEach((d) => counts[d] = (counts[d] || 0) + 1);

      const parts = [];
      if (counts.left) parts.push(`${counts.left} left`);
      if (counts.center) parts.push(`${counts.center} center`);
      if (counts.right) parts.push(`${counts.right} right`);
      if (parts.length === 0) parts.push("in front");

      msg = `${people.length} people detected: ${parts.join(", ")}.`;
    }

    setStatus(msg);
    speak(msg);

  } catch (err) {
    const msg = `Error. ${err.message}`;
    setStatus(msg);
    speak("Error.");
  } finally {
    busy = false;
    btnCapture.disabled = false;
  }
}

// ---------- Event ----------
btnCapture.addEventListener("click", takeAndDescribe);

// Initial UX
setStatus('Ready. Tap “Take photo”.');
