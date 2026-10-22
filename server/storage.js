// File storage for uploaded images, conversion results and receipts.
// On Vercel: a *private* Vercel Blob store. Connecting the store to the
// project adds BLOB_STORE_ID, and the Blob SDK then authenticates with
// Vercel's automatic OIDC credentials. A BLOB_READ_WRITE_TOKEN also works.
// Locally (neither set): files under data/blobs, served through signed links.
import crypto from "crypto";
import fs from "fs/promises";
import path from "path";
import { DATA_DIR } from "./db.js";
import { secret } from "./secret.js";

export const usingBlob = Boolean(process.env.BLOB_STORE_ID || process.env.BLOB_READ_WRITE_TOKEN);

if (!usingBlob && process.env.VERCEL) {
  throw new Error(
    "No Blob store is connected. Create a private Blob store and connect it to the Vercel project."
  );
}

const LOCAL_DIR = path.join(DATA_DIR, "blobs");

// Only allow simple relative paths such as "uploads/abc/photo-x1y2.jpg".
export function isSafePathname(pathname) {
  return (
    typeof pathname === "string" &&
    pathname.length < 300 &&
    /^[\w-]+(\/[\w.-]+)+$/.test(pathname) &&
    !pathname.split("/").some((part) => part === ".." || part === ".")
  );
}

function localPath(pathname) {
  if (!isSafePathname(pathname)) throw new Error("Invalid file path.");
  return path.join(LOCAL_DIR, ...pathname.split("/"));
}

let blobSdk;

async function blob() {
  blobSdk ||= await import("@vercel/blob");
  return blobSdk;
}

async function streamToBuffer(stream) {
  const chunks = [];

  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

/** Reads a stored file into memory. Returns null if it doesn't exist. */
export async function readFile(pathname) {
  if (usingBlob) {
    const { get } = await blob();
    const result = await get(pathname, { access: "private", useCache: false });

    return result?.stream ? streamToBuffer(result.stream) : null;
  }

  try {
    return await fs.readFile(localPath(pathname));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

/** Stores a file under pathname (a random suffix is added). Returns the final pathname. */
export async function writeFile(pathname, buffer, contentType) {
  if (usingBlob) {
    const { put } = await blob();
    const result = await put(pathname, buffer, {
      access: "private",
      addRandomSuffix: true,
      contentType,
    });

    return result.pathname;
  }

  const ext = path.extname(pathname);
  const final = `${pathname.slice(0, pathname.length - ext.length)}-${crypto.randomBytes(8).toString("hex")}${ext}`;
  const file = localPath(final);

  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, buffer);
  return final;
}

export async function deleteFiles(pathnames) {
  const list = pathnames.filter(Boolean);

  if (list.length === 0) return;

  if (usingBlob) {
    const { del } = await blob();
    await del(list);
    return;
  }

  await Promise.all(list.map((p) => fs.rm(localPath(p), { force: true })));
}

// ---------- Temporary download links ----------

function signLocal(pathname, expires) {
  return crypto.createHmac("sha256", secret()).update(`${pathname}:${expires}`).digest("base64url");
}

/** A short-lived URL that lets the browser download a private file. */
export async function downloadUrl(pathname, minutes = 15) {
  const validUntil = Date.now() + minutes * 60 * 1000;

  if (usingBlob) {
    const { issueSignedToken, presignUrl } = await blob();
    const token = await issueSignedToken({
      pathname,
      operations: ["get"],
      validUntil,
    });
    const { presignedUrl } = await presignUrl(token, {
      operation: "get",
      pathname,
      access: "private",
      validUntil,
    });

    return presignedUrl;
  }

  const params = new URLSearchParams({
    p: pathname,
    e: String(validUntil),
    s: signLocal(pathname, validUntil),
  });

  return `/api/files?${params}`;
}

/** Checks a local download link (development only). */
export function verifyLocalLink({ p, e, s }) {
  if (!isSafePathname(p) || !(Number(e) > Date.now())) return false;

  const expected = signLocal(p, Number(e));

  return (
    typeof s === "string" &&
    s.length === expected.length &&
    crypto.timingSafeEqual(Buffer.from(s), Buffer.from(expected))
  );
}

export function localFilePath(pathname) {
  return localPath(pathname);
}

/** Deletes temporary uploads and results older than maxAgeMs. */
export async function cleanupOldFiles(prefixes, maxAgeMs) {
  const cutoff = Date.now() - maxAgeMs;
  let removed = 0;

  if (usingBlob) {
    const { list, del } = await blob();

    for (const prefix of prefixes) {
      let cursor;

      do {
        const page = await list({ prefix, cursor, limit: 1000 });
        const old = page.blobs
          .filter((b) => new Date(b.uploadedAt).getTime() < cutoff)
          .map((b) => b.url);

        if (old.length) {
          await del(old);
          removed += old.length;
        }

        cursor = page.hasMore ? page.cursor : undefined;
      } while (cursor);
    }

    return removed;
  }

  for (const prefix of prefixes) {
    const dir = path.join(LOCAL_DIR, prefix.replace(/\/$/, ""));
    const entries = await fs.readdir(dir, { recursive: true, withFileTypes: true }).catch(() => []);

    for (const entry of entries) {
      if (!entry.isFile()) continue;

      const file = path.join(entry.parentPath ?? entry.path, entry.name);
      const stat = await fs.stat(file);

      if (stat.mtimeMs < cutoff) {
        await fs.rm(file, { force: true });
        removed++;
      }
    }
  }

  return removed;
}
