// Pro features: names and alt text for images (written by Google Gemini),
// and creating images from a description (further down).
// The browser sends a small JPEG preview of each image (not the original),
// Gemini describes it, and nothing is stored.
import crypto from "crypto";
import express from "express";
import { one } from "./db.js";
import { isPro, requireUser } from "./auth.js";

const API_KEY = process.env.GEMINI_API_KEY || "";
const MODEL = process.env.GEMINI_MODEL || "gemini-flash-lite-latest";
// GEMINI_API_BASE is only for automated tests against a fake Gemini server.
const API_BASE = process.env.GEMINI_API_BASE || "https://generativelanguage.googleapis.com";
// Per user per day, so one account can't use up the free Gemini quota.
const DAILY_LIMIT = Number(process.env.AI_DAILY_LIMIT) || 200;

const MAX_IMAGE_BASE64 = 700_000; // ~500 KB preview

// What the AI writes for each field the user asked for.
const FIELDS = {
  name: `- name: a short, descriptive, SEO-friendly file name in lowercase English words joined with hyphens, 2 to 6 words, no file extension, no numbers unless they are visible and important (e.g. "red-vintage-bicycle-brick-wall").`,
  alt: `- alt: alt text for screen readers, one plain sentence under 125 characters that says what the image shows. Don't start with "Image of" or "Picture of". Include any important visible text.`,
};

function promptFor(fields) {
  return `You write file names and alt text for images on websites.
Look at the image and return:
${fields.map((f) => FIELDS[f]).join("\n")}`;
}

const httpError = (status, message) => Object.assign(new Error(message), { status });

export const aiEnabled = () => Boolean(API_KEY);

function slugify(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60)
    .replace(/-$/, "");
}

async function overDailyLimit(userId) {
  const row = await one(
    `INSERT INTO rate_limits (key, count, reset_at)
     VALUES ($1, 1, date_trunc('day', now()) + interval '1 day')
     ON CONFLICT (key) DO UPDATE SET
       count = CASE WHEN rate_limits.reset_at < now() THEN 1 ELSE rate_limits.count + 1 END,
       reset_at = CASE WHEN rate_limits.reset_at < now() THEN date_trunc('day', now()) + interval '1 day' ELSE rate_limits.reset_at END
     RETURNING count`,
    [`ai:${userId}`]
  );

  return row.count > DAILY_LIMIT;
}

function callGemini(base64, mimeType, fields) {
  return fetch(
    `${API_BASE}/v1beta/models/${encodeURIComponent(MODEL)}:generateContent`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": API_KEY },
      body: JSON.stringify({
        contents: [
          {
            parts: [{ inline_data: { mime_type: mimeType, data: base64 } }, { text: promptFor(fields) }],
          },
        ],
        generationConfig: {
          temperature: 0.4,
          responseMimeType: "application/json",
          responseSchema: {
            type: "OBJECT",
            properties: Object.fromEntries(fields.map((f) => [f, { type: "STRING" }])),
            required: fields,
          },
        },
      }),
      signal: AbortSignal.timeout(30_000),
    }
  );
}

async function describeImage(base64, mimeType, fields) {
  let response = await callGemini(base64, mimeType, fields);

  // 503 = Gemini is overloaded for a moment: try once more.
  if (response.status === 503) {
    await new Promise((r) => setTimeout(r, 1500));
    response = await callGemini(base64, mimeType, fields);
  }

  const data = await response.json().catch(() => ({}));

  if (response.status === 429 || response.status === 503) {
    throw httpError(429, "The AI is busy right now. Please wait a minute and try again.");
  }

  if (!response.ok) {
    console.error("[ai] Gemini error:", response.status, JSON.stringify(data.error || data).slice(0, 500));
    throw httpError(502, "Couldn't describe this image. Please try again.");
  }

  const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("") || "";
  let result;

  try {
    result = JSON.parse(text);
  } catch {
    result = null;
  }

  const name = slugify(result?.name);
  const alt = String(result?.alt || "").replace(/\s+/g, " ").trim().slice(0, 250);

  if ((fields.includes("name") && !name) || (fields.includes("alt") && !alt)) {
    // e.g. blocked by safety filters
    throw httpError(422, "Couldn't describe this image.");
  }

  return Object.fromEntries(fields.map((f) => [f, f === "name" ? name : alt]));
}

export const aiRouter = express.Router();

aiRouter.use(express.json({ limit: "1mb" }));

aiRouter.post("/describe", requireUser, async (req, res, next) => {
  try {
    if (!isPro(req.user)) throw httpError(402, "Image names and alt text are a Pro feature.");
    if (!aiEnabled()) throw httpError(503, "The AI isn't set up yet (GEMINI_API_KEY).");

    const match = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(req.body.image || ""));

    if (!match) throw httpError(400, "Send the image as a base64 JPEG, PNG or WEBP.");
    if (match[2].length > MAX_IMAGE_BASE64) throw httpError(413, "The preview image is too large.");

    // Names, alt text or both (default both).
    const fields = ["name", "alt"].filter((f) => !Array.isArray(req.body.fields) || req.body.fields.includes(f));

    if (fields.length === 0) throw httpError(400, "Choose file names, alt text or both.");

    if (await overDailyLimit(req.user.id)) {
      throw httpError(429, `You've reached today's limit of ${DAILY_LIMIT} images. Try again tomorrow.`);
    }

    res.json(await describeImage(match[2], match[1], fields));
  } catch (error) {
    next(error);
  }
});

// ---------- Image generation (Pro) ----------
// Pollinations.ai makes the images. Without a key, the free tier allows one
// image every 45 seconds per IP. On Vercel every user shares the server's
// IPs, so there the server hands the browser the image address and each
// user's browser fetches its own image ("direct"). Pollinations only allows
// that from a real website, not localhost, so local development fetches on
// the server. With POLLINATIONS_API_KEY the server always fetches (no wait).

const POLLINATIONS_KEY = process.env.POLLINATIONS_API_KEY || "";
const IMAGE_DAILY_LIMIT = Number(process.env.IMAGE_DAILY_LIMIT) || 50;

const STYLES = {
  none: "",
  photo: "professional photograph, natural light, sharp focus, high detail",
  illustration: "digital illustration, clean lines, vibrant colours",
  "3d": "3D render, soft studio lighting, octane render, high detail",
  watercolor: "watercolor painting, soft washes, paper texture",
  anime: "anime style, cel shading, detailed background",
  flat: "flat vector illustration, simple shapes, minimal, solid colours",
  pixel: "pixel art, 16-bit, crisp pixels",
  sketch: "pencil sketch, hand-drawn, cross-hatching, monochrome",
};

const SHAPES = {
  square: [1024, 1024],
  landscape: [1216, 832],
  portrait: [832, 1216],
  wide: [1344, 768],
};

export const imageFree = () => !POLLINATIONS_KEY;

// POLLINATIONS_MODE (direct/server) overrides the choice described above.
export const imageMode = () =>
  ["direct", "server"].includes(process.env.POLLINATIONS_MODE)
    ? process.env.POLLINATIONS_MODE
    : POLLINATIONS_KEY || !process.env.VERCEL
      ? "server"
      : "direct";

async function overImageLimit(userId) {
  const row = await one(
    `INSERT INTO rate_limits (key, count, reset_at)
     VALUES ($1, 1, date_trunc('day', now()) + interval '1 day')
     ON CONFLICT (key) DO UPDATE SET
       count = CASE WHEN rate_limits.reset_at < now() THEN 1 ELSE rate_limits.count + 1 END,
       reset_at = CASE WHEN rate_limits.reset_at < now() THEN date_trunc('day', now()) + interval '1 day' ELSE rate_limits.reset_at END
     RETURNING count`,
    [`img:${userId}`]
  );

  return row.count > IMAGE_DAILY_LIMIT;
}

// Gives back a use when the free service asked us to wait (nothing was made).
const refundImage = (userId) =>
  one("UPDATE rate_limits SET count = GREATEST(0, count - 1) WHERE key = $1", [`img:${userId}`]);

function imageUrl({ prompt, width, height, seed, enhance }) {
  const params = new URLSearchParams({ width, height, seed, nologo: "true" });

  if (enhance) params.set("enhance", "true");

  return POLLINATIONS_KEY
    ? `https://gen.pollinations.ai/image/${encodeURIComponent(prompt)}?${params}&model=flux`
    : `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?${params}`;
}

aiRouter.post("/image", requireUser, async (req, res, next) => {
  try {
    if (!isPro(req.user)) throw httpError(402, "Creating images is a Pro feature.");

    const prompt = String(req.body.prompt || "").replace(/\s+/g, " ").trim();
    const style = STYLES[req.body.style] !== undefined ? req.body.style : "none";
    const [width, height] = SHAPES[req.body.shape] || SHAPES.square;
    const seed = Number.isInteger(req.body.seed) ? Math.abs(req.body.seed) % 1e9 : crypto.randomInt(1e9);

    if (prompt.length < 3) throw httpError(400, "Describe the image you want (a few words at least).");
    if (prompt.length > 600) throw httpError(400, "Keep the description under 600 characters.");

    if (await overImageLimit(req.user.id)) {
      throw httpError(429, `You've reached today's limit of ${IMAGE_DAILY_LIMIT} images. Try again tomorrow.`);
    }

    const fullPrompt = [prompt, STYLES[style]].filter(Boolean).join(", ");
    const url = imageUrl({ prompt: fullPrompt, width, height, seed, enhance: Boolean(req.body.enhance) });

    if (imageMode() === "direct") return res.json({ mode: "direct", url, seed, width, height });

    const image = await fetch(url, {
      headers: POLLINATIONS_KEY ? { Authorization: `Bearer ${POLLINATIONS_KEY}` } : {},
      signal: AbortSignal.timeout(120_000),
    });
    const type = image.headers.get("content-type") || "";

    // Free tier: "1 image every 45 seconds". Tell the browser how long to wait.
    if (image.status === 402 || image.status === 429) {
      const message = (await image.json().catch(() => ({})))?.error?.message || "";

      await refundImage(req.user.id);
      return res.status(429).json({
        message: "The free image service needs a short break between images.",
        retryAfter: Number(/(\d+)\s*s/.exec(message)?.[1]) || 45,
      });
    }

    if (!image.ok || !type.startsWith("image/")) {
      console.error("[ai] Pollinations error:", image.status, (await image.text().catch(() => "")).slice(0, 300));
      throw httpError(image.status === 429 ? 429 : 502, "Couldn't create the image right now. Please try again.");
    }

    res.set({ "Content-Type": type, "X-Image-Seed": String(seed), "Cache-Control": "no-store" });
    res.send(Buffer.from(await image.arrayBuffer()));
  } catch (error) {
    next(error);
  }
});
