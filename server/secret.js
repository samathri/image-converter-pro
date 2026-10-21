// The key that signs visitor cookies and local download links.
// On Vercel it must come from the SESSION_SECRET environment variable
// (the filesystem there is read-only and not kept between requests).
import crypto from "crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import path from "path";
import { DATA_DIR } from "./db.js";

let cached;

export function secret() {
  if (cached) return cached;

  if (process.env.SESSION_SECRET) {
    cached = process.env.SESSION_SECRET;
    return cached;
  }

  if (process.env.VERCEL) {
    throw new Error("SESSION_SECRET is not set. Add it to the Vercel project's environment variables.");
  }

  const file = path.join(DATA_DIR, ".secret");

  if (!existsSync(file)) {
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(file, crypto.randomBytes(32).toString("hex"));
  }

  cached = readFileSync(file, "utf8").trim();
  return cached;
}
