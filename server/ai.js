// Pro feature: names and alt text for images, written by Google Gemini.
// The browser sends a small JPEG preview of each image (not the original),
// Gemini describes it, and nothing is stored.
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

const PROMPT = `You write file names and alt text for images on websites.
Look at the image and return:
- name: a short, descriptive, SEO-friendly file name in lowercase English words joined with hyphens, 2 to 6 words, no file extension, no numbers unless they are visible and important (e.g. "red-vintage-bicycle-brick-wall").
- alt: alt text for screen readers, one plain sentence under 125 characters that says what the image shows. Don't start with "Image of" or "Picture of". Include any important visible text.`;

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

function callGemini(base64, mimeType) {
  return fetch(
    `${API_BASE}/v1beta/models/${encodeURIComponent(MODEL)}:generateContent`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": API_KEY },
      body: JSON.stringify({
        contents: [
          {
            parts: [{ inline_data: { mime_type: mimeType, data: base64 } }, { text: PROMPT }],
          },
        ],
        generationConfig: {
          temperature: 0.4,
          responseMimeType: "application/json",
          responseSchema: {
            type: "OBJECT",
            properties: { name: { type: "STRING" }, alt: { type: "STRING" } },
            required: ["name", "alt"],
          },
        },
      }),
      signal: AbortSignal.timeout(30_000),
    }
  );
}

async function describeImage(base64, mimeType) {
  let response = await callGemini(base64, mimeType);

  // 503 = Gemini is overloaded for a moment: try once more.
  if (response.status === 503) {
    await new Promise((r) => setTimeout(r, 1500));
    response = await callGemini(base64, mimeType);
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

  if (!name || !alt) {
    // e.g. blocked by safety filters
    throw httpError(422, "Couldn't describe this image.");
  }

  return { name, alt };
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

    if (await overDailyLimit(req.user.id)) {
      throw httpError(429, `You've reached today's limit of ${DAILY_LIMIT} images. Try again tomorrow.`);
    }

    res.json(await describeImage(match[2], match[1]));
  } catch (error) {
    next(error);
  }
});
