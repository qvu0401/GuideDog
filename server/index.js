import express from "express";
import multer from "multer";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { Readable } from "stream";
import { EyePop } from "@eyepop.ai/eyepop";

dotenv.config();

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

const PORT = process.env.PORT || 5173;

if (!process.env.EYEPOP_SECRET_KEY || !process.env.EYEPOP_POP_ID) {
  console.error("❌ Missing EYEPOP_API_KEY or EYEPOP_POP_ID in server/.env");
  process.exit(1);
}

/* -------------------- Serve static frontend -------------------- */
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
app.use(express.static(path.join(__dirname, "..", "public")));

/* -------------------- EyePop SDK: connect once -------------------- */
let endpoint = null;

async function connectEyePop() {
  if (endpoint) return endpoint;

  endpoint = await EyePop.workerEndpoint({
    popId: process.env.EYEPOP_POP_ID,
    auth: { apiKey: process.env.EYEPOP_SECRET_KEY },
  }).connect();

  console.log("✅ EyePop workerEndpoint connected");
  return endpoint;
}

// connect immediately so auth errors appear on startup
await connectEyePop();

/* -------------------- DEBUG ROUTE: /api/test -------------------- */
/*
   Open in browser:
   http://localhost:5173/api/test

   This runs EyePop on a known public image and shows
   whether `objects` are being produced.
*/
app.get("/api/test", async (req, res) => {
  try {
    const ep = await connectEyePop();

    const testImageUrl =
      "https://farm2.staticflickr.com/1080/1301049949_532835a8b5_z.jpg";

    const results = await ep.process({ url: testImageUrl });

    const all = [];

    for await (const r of results) {
      all.push({
        enumerableKeys: Object.keys(r),
        hasObjectsProp: "objects" in r,
        objectsLen: r.objects?.length ?? 0,
        objects: r.objects ?? [],
        source_width: r.source_width,
        source_height: r.source_height,
        seconds: r.seconds,
      });
    }

    res.json({
      count: all.length,
      all,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

/* -------------------- MAIN ROUTE: /api/infer -------------------- */
/*
   Called by the browser when clicking VERIFY
*/
app.post("/api/infer", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    const ep = await connectEyePop();

    const readable = Readable.from(req.file.buffer);
    const mimeType = req.file.mimetype || "image/jpeg";

    const results = await ep.process({
      stream: readable,
      mimeType,
    });

    let best = null;
    const all = [];

    for await (const r of results) {
      const n = r.objects?.length ?? 0;

      all.push({
        objectsLen: n,
        objects: r.objects ?? [],
        source_width: r.source_width,
        source_height: r.source_height,
        seconds: r.seconds,
      });

      const bestN = best?.objects?.length ?? 0;
      if (!best || n > bestN) best = r;
    }

    res.json({
      best: {
        objectsLen: best?.objects?.length ?? 0,
        objects: best?.objects ?? [],
      },
      all,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

/* -------------------- Start server -------------------- */
app.listen(PORT, () => {
  console.log(`🚀 Server running at http://localhost:${PORT}`);
});
