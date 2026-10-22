// The Express app. Used by server/index.js locally and by api/index.js
// as a Vercel Function.
import "./env.js";
import express from "express";
import multer from "multer";
import AdmZip from "adm-zip";
import path from "path";
import { compressToTarget, downloadImage } from "./converter.js";
import { identify, getAccount, reserveUse, PRO_MAX_IMAGES } from "./quota.js";
import { authRouter, ensureBootstrapAdmin, loadUser } from "./auth.js";
import { billingRouter, adminRouter } from "./billing.js";
import { payhereRouter, payhereNotifyRouter } from "./payhere.js";
import { paypalRouter } from "./paypal.js";
import {
  cleanupTemporaryFiles,
  cronRouter,
  filesRouter,
  IMAGE_MAX_BYTES,
  receiptPrefix,
  uploadPrefix,
  uploadsRouter,
} from "./uploads.js";
import { deleteFiles, downloadUrl, isSafePathname, readFile, usingBlob, writeFile } from "./storage.js";

const ALLOWED_FORMATS = ["avif", "webp", "jpeg", "jpg", "png"];

const MIME_TYPES = {
  avif: "image/avif",
  webp: "image/webp",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  png: "image/png",
};

const app = express();

// Behind Vercel's (or another) proxy, so req.ip is the visitor's address.
if (process.env.VERCEL) {
  app.set("trust proxy", true);
} else if (process.env.TRUST_PROXY) {
  app.set("trust proxy", Number(process.env.TRUST_PROXY) || process.env.TRUST_PROXY);
}

app.disable("x-powered-by");

// PayHere calls this from its own servers (form-encoded, no session),
// so it is mounted before the browser-only middleware below.
app.use("/api/payhere", payhereNotifyRouter);
app.use("/api/cron", cronRouter);

// Reject state-changing requests sent from other websites.
app.use("/api", (req, res, next) => {
  const origin = req.headers.origin;

  if (!["GET", "HEAD", "OPTIONS"].includes(req.method) && origin && new URL(origin).host !== req.headers.host) {
    return res.status(403).json({ message: "Cross-site request blocked." });
  }

  next();
});

app.use("/api", express.json({ limit: "64kb" }));

app.use("/api", (req, res, next) => {
  ensureBootstrapAdmin().then(() => next(), next);
});

app.use("/api", loadUser, identify);

app.get("/api/me", async (req, res, next) => {
  try {
    res.json({
      ...(await getAccount(req)),
      storage: usingBlob ? "blob" : "local",
      uploadPrefix: uploadPrefix(req),
      receiptPrefix: receiptPrefix(req),
    });
  } catch (error) {
    next(error);
  }
});

app.use("/api/auth", authRouter);
app.use("/api/uploads", uploadsRouter);
app.use("/api/files", filesRouter);
app.use("/api/billing/payhere", payhereRouter);
app.use("/api/billing/paypal", paypalRouter);
app.use("/api/billing", billingRouter);
app.use("/api/admin", adminRouter);

// Converts images the browser already uploaded (see uploads.js) and/or
// downloads from URLs. Returns a temporary link to the result.
app.post("/api/convert", async (req, res, next) => {
  let reservation = null;

  const uploads = (Array.isArray(req.body.uploads) ? req.body.uploads : [])
    .slice(0, PRO_MAX_IMAGES)
    .map((u) => ({ pathname: String(u?.pathname || ""), name: String(u?.name || "image") }));

  // Only this visitor's own uploads can be converted.
  const prefix = uploadPrefix(req);
  const validUploads = uploads.filter((u) => isSafePathname(u.pathname) && u.pathname.startsWith(prefix));

  try {
    const formats = [].concat(req.body.formats || [])
      .map((f) => String(f).toLowerCase())
      .filter((f) => ALLOWED_FORMATS.includes(f));

    const imageUrls = [].concat(req.body.imageUrls || [])
      .map((u) => String(u).trim())
      .filter(Boolean)
      .slice(0, PRO_MAX_IMAGES);

    const targetSize = Number(req.body.targetSize);
    const targetBytes = req.body.sizeUnit === "MB" ? targetSize * 1024 * 1024 : targetSize * 1024;

    if (validUploads.length !== uploads.length) {
      return res.status(400).json({ message: "Some uploaded files are not valid. Please add them again." });
    }

    if (formats.length === 0) {
      return res.status(400).json({ message: "Select at least one output format" });
    }

    if (!(targetSize > 0)) {
      return res.status(400).json({ message: "Target size must be greater than 0" });
    }

    reservation = await reserveUse(req, validUploads.length + imageUrls.length);

    if (!reservation.ok) {
      return res.status(reservation.status).json({
        code: reservation.code,
        message: reservation.message,
        account: await getAccount(req),
      });
    }

    const allFiles = [];

    for (const upload of validUploads) {
      const buffer = await readFile(upload.pathname);

      if (!buffer) throw Object.assign(new Error("An uploaded image has expired. Please add it again."), { status: 400 });
      allFiles.push({ buffer, name: upload.name });
    }

    const failedUrls = [];

    for (const url of imageUrls) {
      try {
        allFiles.push(await downloadImage(url, IMAGE_MAX_BYTES));
      } catch (error) {
        console.error("Failed URL:", url, error.message);
        failedUrls.push(url);
      }
    }

    if (allFiles.length === 0) {
      await reservation.release();

      return res.status(400).json({
        message: failedUrls.length > 0 ? "None of the URLs could be downloaded" : "No files or URLs provided",
        failedUrls,
      });
    }

    const outputs = [];
    const usedNames = new Set();

    for (const file of allFiles) {
      const filename = path.parse(file.name).name.replace(/[^\w.-]+/g, "_") || "image";

      for (const format of formats) {
        const buffer = await compressToTarget(file.buffer, format, targetBytes);

        let name = `${filename}.${format}`;
        let n = 1;

        while (usedNames.has(name)) name = `${filename}_${n++}.${format}`;

        usedNames.add(name);
        outputs.push({ name, buffer, format });
      }
    }

    // One result is stored as-is, several are bundled in a zip.
    let result;

    if (outputs.length === 1) {
      const [only] = outputs;
      result = { name: only.name, buffer: only.buffer, type: MIME_TYPES[only.format] };
    } else {
      const zip = new AdmZip();

      for (const output of outputs) zip.addFile(output.name, output.buffer);
      result = { name: "converted-images.zip", buffer: zip.toBuffer(), type: "application/zip" };
    }

    const stored = await writeFile(`results/${req.visitorId}/${result.name}`, result.buffer, result.type);

    res.json({
      downloadUrl: await downloadUrl(stored),
      filename: result.name,
      size: result.buffer.length,
      failedUrls,
    });
  } catch (error) {
    await reservation?.release?.().catch(() => {});
    next(error);
  } finally {
    // The originals are no longer needed.
    deleteFiles(validUploads.map((u) => u.pathname)).catch(() => {});

    if (!usingBlob) cleanupTemporaryFiles().catch(() => {});
  }
});

app.use("/api", (req, res) => {
  res.status(404).json({ message: "Not found." });
});

app.use((error, req, res, next) => {
  // Multer errors (file too large, too many files)
  if (error instanceof multer.MulterError) {
    return res.status(400).json({ message: error.message });
  }

  if (error.status && error.status < 500) {
    return res.status(error.status).json({ message: error.message });
  }

  console.error(error);
  res.status(500).json({ message: "Something went wrong." });
});

export default app;
