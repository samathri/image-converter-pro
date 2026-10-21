// Creates an admin account, or promotes an existing user to admin.
// Usage: npm run create-admin -- <email> <password> [name]
// For the Vercel database, first run `vercel env pull .env.local` so
// DATABASE_URL points at it.
import "./env.js";
import { one } from "./db.js";
import { createUser, hashPassword } from "./auth.js";
import { usingLocalDatabase } from "./db.js";

const [email, password, ...nameParts] = process.argv.slice(2);
const name = nameParts.join(" ") || "Admin";

if (!email || !password) {
  console.error("Usage: npm run create-admin -- <email> <password> [name]");
  process.exit(1);
}

if (password.length < 8) {
  console.error("Password must be at least 8 characters.");
  process.exit(1);
}

// The local database (PGlite) can only be opened by one program at a time.
if (usingLocalDatabase) {
  const port = process.env.PORT || 3001;
  const running = await fetch(`http://localhost:${port}/api/me`, { signal: AbortSignal.timeout(1500) })
    .then(() => true)
    .catch(() => false);

  if (running) {
    console.error(
      `The app is running on port ${port}. Stop it first (Ctrl+C), then run this again.\n` +
        "Or set ADMIN_EMAIL and ADMIN_PASSWORD in .env and restart: the admin is created automatically."
    );
    process.exit(1);
  }
}

const normalized = email.trim().toLowerCase();
const existing = await one("SELECT id FROM users WHERE email = $1", [normalized]);

if (existing) {
  await one("UPDATE users SET role = 'admin', password_hash = $1 WHERE id = $2", [
    await hashPassword(password),
    existing.id,
  ]);
  console.log(`${normalized} is now an admin (password updated).`);
} else {
  await createUser({ email: normalized, name, password, role: "admin" });
  console.log(`Admin account created for ${normalized}.`);
}

console.log(usingLocalDatabase ? "(local development database)" : "(database from DATABASE_URL)");
process.exit(0);
