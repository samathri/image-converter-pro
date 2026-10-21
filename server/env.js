// Loads settings from .env (and .env.local, which `vercel env pull`
// creates) in the project folder. Imported first so every other module
// sees the values. On Vercel, settings come from the project instead.
import path from "path";
import { existsSync } from "fs";
import { fileURLToPath } from "url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

for (const name of [".env.local", ".env"]) {
  const file = path.join(root, name);

  // Values already set win, so .env.local overrides .env.
  if (existsSync(file)) process.loadEnvFile(file);
}
