// Uploads go straight from the browser to storage, so they never pass
// through a Vercel Function (which is limited to 4.5 MB per request).
import express from "express";
import multer from "multer";
import { canConvert } from "./quota.js";
import { RECEIPT_MAX_BYTES, RECEIPT_TYPES } from "./billing.js";
import {
  cleanupOldFiles,
  isSafePathname,
  localFilePath,
  usingBlob,
  verifyLocalLink,
  writeFile,
} from "./storage.js";

export const IMAGE_MAX_BYTES = 25 * 1024 * 1024;
const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/avif"];
const TEMP_MAX_AGE_MS = 60 * 60 * 1000; // uploads and results live for 1 hour

/** Folder each visitor/user may upload into. */
export function uploadPrefix(req) {
  return `uploads/${req.visitorId}/`;
}

export function receiptPrefix(req) {
  return req.user ? `receipts/${req.user.id}/` : null;
}

const httpError = (status, message) => Object.assign(new Error(message), { status });

// Decides whether an upload is allowed and with which limits.
async function uploadRules(req, purpose, pathname) {
  if (!isSafePathname(pathname)) throw httpError(400, "Invalid file name.");

  if (purpose === "receipt") {
    const prefix = receiptPrefix(req);

    if (!prefix) throw httpError(401, "Please log in first.");
    if (!pathname.startsWith(prefix)) throw httpError(403, "Not allowed.");

    return { allowedContentTypes: RECEIPT_TYPES, maximumSizeInBytes: RECEIPT_MAX_BYTES };
  }

  if (!pathname.startsWith(uploadPrefix(req))) throw httpError(403, "Not allowed.");

  // Don't accept uploads from visitors who can't convert anything anyway.
  if (!(await canConvert(req))) {
    throw httpError(402, "You've used all your free conversions. Upgrade to Pro to keep converting.");
  }

  return { allowedContentTypes: IMAGE_TYPES, maximumSizeInBytes: IMAGE_MAX_BYTES };
}

export const uploadsRouter = express.Router();

// Vercel Blob uploads: hands the browser a short-lived presigned upload URL.
// Works with Vercel's automatic OIDC credentials (or a read-write token).
uploadsRouter.post("/", async (req, res, next) => {
  if (!usingBlob) return next(httpError(404, "Not found."));

  try {
    const [{ issueSignedToken }, { handleUploadPresigned }] = await Promise.all([
      import("@vercel/blob"),
      import("@vercel/blob/client"),
    ]);

    const result = await handleUploadPresigned({
      body: req.body,
      request: req,
      getSignedToken: async (pathname, clientPayload) => {
        const { purpose } = JSON.parse(clientPayload || "{}");
        const rules = await uploadRules(req, purpose, pathname);
        const validUntil = Date.now() + 10 * 60 * 1000;

        return {
          token: await issueSignedToken({
            pathname,
            operations: ["put"],
            validUntil,
            ...rules,
          }),
          urlOptions: {
            ...rules,
            validUntil,
            addRandomSuffix: true,
            allowOverwrite: false,
          },
        };
      },
    });

    res.json(result);
  } catch (error) {
    next(error.status ? error : httpError(400, error.message));
  }
});

// Local development: files are posted here and saved under data/blobs.
const localUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: IMAGE_MAX_BYTES, files: 1 },
});

uploadsRouter.post("/local", localUpload.single("file"), async (req, res, next) => {
  if (usingBlob) return next(httpError(404, "Not found."));

  try {
    const purpose = String(req.body.purpose || "image");
    const pathname = String(req.body.pathname || "");
    const rules = await uploadRules(req, purpose, pathname);

    if (!req.file) throw httpError(400, "No file received.");
    if (req.file.size > rules.maximumSizeInBytes) throw httpError(400, "File is too large.");
    if (!rules.allowedContentTypes.includes(req.file.mimetype)) throw httpError(400, "This file type isn't allowed.");

    res.json({ pathname: await writeFile(pathname, req.file.buffer, req.file.mimetype) });
  } catch (error) {
    next(error);
  }
});

// Local development: signed download links (Vercel Blob has its own).
export const filesRouter = express.Router();

filesRouter.get("/", (req, res) => {
  if (usingBlob || !verifyLocalLink(req.query)) {
    return res.status(404).json({ message: "This link has expired." });
  }

  res.setHeader("Cache-Control", "private, no-store");
  res.sendFile(localFilePath(req.query.p));
});

// Deletes temporary uploads and results. On Vercel a daily cron calls this;
// locally it also runs after each conversion.
export async function cleanupTemporaryFiles() {
  return cleanupOldFiles(["uploads/", "results/"], TEMP_MAX_AGE_MS);
}

export const cronRouter = express.Router();

cronRouter.get("/cleanup", async (req, res, next) => {
  const secret = process.env.CRON_SECRET;

  if (!secret || req.headers.authorization !== `Bearer ${secret}`) {
    return res.status(401).json({ message: "Unauthorized." });
  }

  try {
    res.json({ removed: await cleanupTemporaryFiles() });
  } catch (error) {
    next(error);
  }
});
