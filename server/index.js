import express from "express";
import multer from "multer";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { Readable } from "stream";
import { EyePop, PopComponentType, TransientPopId } from "@eyepop.ai/eyepop";

dotenv.config();

const app = express();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 12 * 1024 * 1024 }, // allow a bit bigger since VI uses full image
});

const PORT = process.env.PORT || 5173;

if (!process.env.EYEPOP_SECRET_KEY || !process.env.EYEPOP_POP_ID) {
  console.error("❌ Missing EYEPOP_SECRET_KEY or EYEPOP_POP_ID in server/.env");
  process.exit(1);
}

/* -------------------- Serve static frontend -------------------- */
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
app.use(express.static(path.join(__dirname, "..", "public")));

/* -------------------- Person Detection Pop (fast) -------------------- */
let detectEndpoint = null;

// Serialize access to detectEndpoint
let detectQueue = Promise.resolve();
function runDetectExclusive(fn) {
  detectQueue = detectQueue.then(fn, fn);
  return detectQueue;
}

async function connectDetect() {
  if (detectEndpoint) return detectEndpoint;

  detectEndpoint = await EyePop.workerEndpoint({
    popId: process.env.EYEPOP_POP_ID, // your Person Detection Pop UUID
    auth: { apiKey: process.env.EYEPOP_SECRET_KEY },
  }).connect();

  console.log("✅ EyePop detect endpoint connected (Pop ID)");
  return detectEndpoint;
}

await connectDetect();

/* -------------------- Visual Intelligence (slow, on-demand) -------------------- */
const VI_POP = {
  components: [
    {
      type: PopComponentType.INFERENCE,
      ability: "eyepop.image-contents:latest",
      params: {
        prompts: [
          {
            // Ask for a single closest person's attributes; still short, but more explicit.
            prompt: [
              "Focus on the closest person in the image (if any).",
              "Return gender as Male/Female/null.",
              "Return activity as one of: walking, running, sitting, standing, drinking, eating, talking, or null.",
              "If unsure, use null.",
              "Keep the answer short.",
            ].join(" "),
          },
        ],
      },
    },
  ],
};

let viEndpoint = null;
let viQueue = Promise.resolve();
function runVIExclusive(fn) {
  viQueue = viQueue.then(fn, fn);
  return viQueue;
}

async function connectVI() {
  if (viEndpoint) return viEndpoint;

  viEndpoint = await EyePop.workerEndpoint({
    popId: TransientPopId.Transient,
    auth: { apiKey: process.env.EYEPOP_SECRET_KEY },
  }).connect();

  await viEndpoint.changePop(VI_POP);
  console.log("✅ EyePop VI endpoint connected (Transient)");
  return viEndpoint;
}

/* -------------------- Clean shutdown -------------------- */
async function shutdown() {
  try {
    if (detectEndpoint) {
      await detectEndpoint.disconnect();
      console.log("🧹 Detect endpoint disconnected");
    }
  } catch (e) {
    console.error("Detect disconnect error:", e?.message || e);
  }

  try {
    if (viEndpoint) {
      await viEndpoint.disconnect();
      console.log("🧹 VI endpoint disconnected");
    }
  } catch (e) {
    console.error("VI disconnect error:", e?.message || e);
  }

  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

/* -------------------- Helpers -------------------- */
function toNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function labelLower(v) {
  return String(v ?? "").trim().toLowerCase();
}

function leftCenterRight(obj, sourceWidth) {
  const W = toNum(sourceWidth, 0);
  if (!W) return "center";

  const x = toNum(obj.x, 0);
  const w = toNum(obj.width, 0);
  const cx = x + w / 2;
  const frac = cx / W;

  if (frac < 0.4) return "left";
  if (frac > 0.6) return "right";
  return "center";
}

function scorePerson(p) {
  const area = toNum(p.width, 0) * toNum(p.height, 0);
  return area * toNum(p.confidence, 0);
}

async function readBestResult(asyncIterable) {
  let best = null;
  let bestN = -1;

  for await (const r of asyncIterable) {
    const n = r.objects?.length ?? 0;
    if (n > bestN) {
      bestN = n;
      best = r;
    }
  }
  return best;
}

// Collect any "classes" arrays anywhere
function collectClassesDeep(node, out = []) {
  if (!node || typeof node !== "object") return out;

  if (Array.isArray(node.classes)) {
    for (const c of node.classes) {
      if (c && typeof c === "object") out.push(c);
    }
  }

  for (const key of Object.keys(node)) {
    const val = node[key];
    if (val && typeof val === "object") {
      if (Array.isArray(val)) {
        for (const item of val) collectClassesDeep(item, out);
      } else {
        collectClassesDeep(val, out);
      }
    }
  }
  return out;
}

function bestByCategory(classes, wantCategory) {
  const want = wantCategory.toLowerCase();
  let best = null;

  for (const c of classes) {
    const cat =
      labelLower(c.category) ||
      labelLower(c.categoryName) ||
      labelLower(c.category_name) ||
      labelLower(c.name);

    if (!cat) continue;

    if (cat === want || cat.includes(want)) {
      const conf = toNum(c.confidence, 0);
      if (!best || conf > toNum(best.confidence, 0)) best = c;
    }
  }
  return best;
}

function extractLabelText(classes) {
  const texts = [];
  for (const c of classes) {
    const s =
      (typeof c.classLabel === "string" && c.classLabel) ||
      (typeof c.label === "string" && c.label) ||
      (typeof c.name === "string" && c.name) ||
      "";
    if (s) texts.push(s);
  }
  return texts.join(" | ");
}

function normalizeGender(v) {
  if (typeof v !== "string") return null;
  const g = v.trim().toLowerCase();
  if (g === "male" || g.includes(" male")) return "male";
  if (g === "female" || g.includes(" female")) return "female";
  return null;
}

function normalizeActivity(v) {
  if (typeof v !== "string") return null;
  const a = v.trim().toLowerCase();
  const allowed = [
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
  for (const k of allowed) {
    if (a === k || a.includes(k)) return k;
  }
  return null;
}

function findGenderActivityInText(text) {
  const t = String(text || "").toLowerCase();

  let gender = null;
  if (t.match(/\bfemale\b/)) gender = "female";
  if (t.match(/\bmale\b/)) gender = gender || "male";

  let activity = null;
  const acts = [
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
  for (const a of acts) {
    if (t.includes(a)) {
      activity = a;
      break;
    }
  }

  return { gender, activity };
}

function collectAllStrings(node, out = []) {
  if (node == null) return out;
  if (typeof node === "string") {
    out.push(node);
    return out;
  }
  if (typeof node !== "object") return out;

  if (Array.isArray(node)) {
    for (const item of node) collectAllStrings(item, out);
    return out;
  }

  for (const k of Object.keys(node)) {
    collectAllStrings(node[k], out);
  }
  return out;
}

/* -------------------- MAIN: /api/infer -------------------- */
/**
 * mode=detect -> your Person Detection Pop (fast)
 * mode=vi     -> detect first (fast), then run VI on FULL image (slower but more accurate)
 * debug=1     -> include vi_debug fields in response (vi mode only)
 */
app.post("/api/infer", upload.single("file"), async (req, res) => {
  try {
    const mode = String(req.query.mode || "detect").toLowerCase();
    const debug = String(req.query.debug || "0") === "1";

    if (!req.file) return res.status(400).json({ error: "No file uploaded" });

    // Always detect first (fast)
    const detectPayload = await runDetectExclusive(async () => {
      const ep = await connectDetect();
      const readable = Readable.from(req.file.buffer);
      const mimeType = req.file.mimetype || "image/jpeg";

      const detectResults = await ep.process({ stream: readable, mimeType });
      const bestDetect = await readBestResult(detectResults);

      const objects = Array.isArray(bestDetect?.objects) ? bestDetect.objects : [];
      const source_width = bestDetect?.source_width ?? null;
      const source_height = bestDetect?.source_height ?? null;

      let people = objects
        .filter(
          (o) =>
            labelLower(o.classLabel) === "person" && toNum(o.confidence, 0) >= 0.35
        )
        .map((o) => ({
          confidence: toNum(o.confidence, 0),
          x: toNum(o.x, 0),
          y: toNum(o.y, 0),
          width: toNum(o.width, 0),
          height: toNum(o.height, 0),
          position: leftCenterRight(o, source_width),
          gender: null,
          genderConfidence: 0,
          activity: null,
          activityConfidence: 0,
        }));

      people.sort((a, b) => scorePerson(b) - scorePerson(a));

      return { source_width, source_height, people };
    });

    if (mode !== "vi") return res.json(detectPayload);

    // Run VI on full image (minimal processing)
    const viPayload = await runVIExclusive(async () => {
      const viEp = await connectVI();

      const viReadable = Readable.from(req.file.buffer);
      const viResults = await viEp.process({
        stream: viReadable,
        mimeType: req.file.mimetype || "image/jpeg",
      });
      const bestVI = await readBestResult(viResults);

      const classes = collectClassesDeep(bestVI, []);
      const labelText = extractLabelText(classes);

      const g0 = bestByCategory(classes, "gender");
      const a0 = bestByCategory(classes, "activity");

      let genderVal = normalizeGender(
        (g0 && (g0.classLabel || g0.label || g0.name)) || null
      );
      let activityVal = normalizeActivity(
        (a0 && (a0.classLabel || a0.label || a0.name)) || null
      );

      if (!genderVal || !activityVal) {
        const ga = findGenderActivityInText(labelText);
        genderVal = genderVal || ga.gender;
        activityVal = activityVal || ga.activity;
      }

      if (!genderVal || !activityVal) {
        const allStrings = collectAllStrings(bestVI, []);
        const giant = allStrings.join(" | ");
        const ga2 = findGenderActivityInText(giant);
        genderVal = genderVal || ga2.gender;
        activityVal = activityVal || ga2.activity;
      }

      // Attach VI results to the closest person if any
      const out = {
        ...detectPayload,
        people: [...detectPayload.people],
      };

      if (out.people.length > 0) {
        out.people[0] = {
          ...out.people[0],
          gender: genderVal,
          genderConfidence: toNum(g0?.confidence, 0),
          activity: activityVal,
          activityConfidence: toNum(a0?.confidence, 0),
        };
      }

      if (debug) {
        out.vi_debug = {
          vi_keys: bestVI ? Object.keys(bestVI) : [],
          classes_len: classes.length,
          sample_classes: classes.slice(0, 8),
          label_text: labelText,
          strings_sample: collectAllStrings(bestVI, []).slice(0, 30),
        };
      }

      return out;
    });

    return res.json(viPayload);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

/* -------------------- Start server -------------------- */
app.listen(PORT, () => {
  console.log(`🚀 Server running at http://localhost:${PORT}`);
});
