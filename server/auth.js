import crypto from "crypto";
import { promisify } from "util";
import express from "express";
import { one, query, toIso } from "./db.js";

const scrypt = promisify(crypto.scrypt);

const SESSION_COOKIE = "icp_session";
const SESSION_DAYS = 30;

// ---------- Passwords ----------

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, 64);

  return `scrypt$${salt.toString("base64")}$${key.toString("base64")}`;
}

async function verifyPassword(password, stored) {
  const [scheme, salt, hash] = stored.split("$");

  if (scheme !== "scrypt") return false;

  const expected = Buffer.from(hash, "base64");
  const key = await scrypt(password, Buffer.from(salt, "base64"), expected.length);

  return crypto.timingSafeEqual(key, expected);
}

// A dummy hash so unknown emails take as long as wrong passwords.
const DUMMY_HASH = await hashPassword(crypto.randomUUID());

// ---------- Users ----------

function newPayRef() {
  // No 0/O/1/I so it's easy to type into a bank transfer.
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.randomBytes(6);

  return "ICP-" + Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
}

export async function createUser({ email, name, password, role = "user", freeUses = 0 }) {
  const passwordHash = await hashPassword(password);

  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      return await one(
        `INSERT INTO users (email, name, password_hash, role, pay_ref, free_uses)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
        [email, name, passwordHash, role, newPayRef(), freeUses]
      );
    } catch (error) {
      if (error.code !== "23505") throw error;

      if (String(error.constraint || error.message).includes("email")) {
        throw Object.assign(new Error("An account with this email already exists."), { status: 409 });
      }
      // pay_ref collision: try another one
    }
  }

  throw new Error("Could not create account. Please try again.");
}

// Keeps the admin account in line with ADMIN_EMAIL / ADMIN_PASSWORD, so no
// command has to be run against the database (handy on Vercel). Creates the
// account if needed; if it exists, makes it an admin and applies the
// password from the settings (only the site owner can change those).
let adminBootstrap;

export function ensureBootstrapAdmin() {
  adminBootstrap ||= (async () => {
    const email = String(process.env.ADMIN_EMAIL || "").trim().toLowerCase();
    const password = process.env.ADMIN_PASSWORD || "";

    if (!email || !password) return;

    if (password.length < 8) {
      console.warn("[admin] ADMIN_PASSWORD must be at least 8 characters; admin not created.");
      return;
    }

    const existing = await one("SELECT id, role, password_hash FROM users WHERE email = $1", [email]);

    if (existing) {
      const samePassword = await verifyPassword(password, existing.password_hash);

      if (existing.role !== "admin" || !samePassword) {
        await query("UPDATE users SET role = 'admin', password_hash = $1 WHERE id = $2", [
          samePassword ? existing.password_hash : await hashPassword(password),
          existing.id,
        ]);
        console.log(`[admin] Updated admin account ${email} from ADMIN_EMAIL / ADMIN_PASSWORD.`);
      }

      return;
    }

    try {
      await createUser({ email, name: "Admin", password, role: "admin" });
      console.log(`[admin] Created admin account for ${email}.`);
    } catch (error) {
      if (error.status !== 409) throw error; // another instance created it first
    }
  })().catch((error) => {
    adminBootstrap = null; // retry on the next request
    throw error;
  });

  return adminBootstrap;
}

export function getUserById(id) {
  return one("SELECT * FROM users WHERE id = $1", [id]);
}

export function isAdmin(user) {
  return user?.role === "admin";
}

// Admins always have full access; users need an active Pro period.
export function isPro(user) {
  return isAdmin(user) || Boolean(user?.pro_until && new Date(user.pro_until) > new Date());
}

// Refuses payment requests from admin accounts (they never need to pay).
export function rejectAdminPayments(req, res, next) {
  if (isAdmin(req.user)) {
    return res.status(400).json({ message: "Admin accounts already have full access and don't need to pay." });
  }

  next();
}

export function publicUser(user) {
  if (!user) return null;

  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    payRef: user.pay_ref,
    proUntil: !isAdmin(user) && isPro(user) ? toIso(user.pro_until) : null,
  };
}

// ---------- Sessions ----------

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export function readCookie(req, name) {
  const match = (req.headers.cookie || "")
    .split(";")
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${name}=`));

  return match ? decodeURIComponent(match.slice(name.length + 1)) : null;
}

export function cookieFlags(req) {
  return ["Path=/", "HttpOnly", "SameSite=Lax", req.secure ? "Secure" : ""].filter(Boolean);
}

function setSessionCookie(req, res, token, maxAge) {
  res.append("Set-Cookie", [`${SESSION_COOKIE}=${token}`, ...cookieFlags(req), `Max-Age=${maxAge}`].join("; "));
}

async function startSession(req, res, userId) {
  const token = crypto.randomBytes(32).toString("base64url");
  const expires = new Date(Date.now() + SESSION_DAYS * 864e5);

  await query("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, $3)", [
    hashToken(token),
    userId,
    expires,
  ]);

  setSessionCookie(req, res, token, SESSION_DAYS * 86400);
}

// Attaches req.user when a valid session cookie is present.
export async function loadUser(req, res, next) {
  try {
    const token = readCookie(req, SESSION_COOKIE);

    req.user = token
      ? (await one(
          "SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = $1 AND s.expires_at > now()",
          [hashToken(token)]
        )) || null
      : null;

    next();
  } catch (error) {
    next(error);
  }
}

export function requireUser(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ message: "Please log in first." });
  }

  next();
}

export function requireAdmin(req, res, next) {
  if (req.user?.role !== "admin") {
    return res.status(req.user ? 403 : 401).json({ message: "Admin access required." });
  }

  next();
}

// ---------- Rate limiting (shared across instances) ----------

const WINDOW_MINUTES = 15;
const MAX_ATTEMPTS = 8;

async function tooManyAttempts(key) {
  const row = await one(
    `INSERT INTO rate_limits (key, count, reset_at)
     VALUES ($1, 1, now() + make_interval(mins => $2))
     ON CONFLICT (key) DO UPDATE SET
       count = CASE WHEN rate_limits.reset_at < now() THEN 1 ELSE rate_limits.count + 1 END,
       reset_at = CASE WHEN rate_limits.reset_at < now() THEN now() + make_interval(mins => $2) ELSE rate_limits.reset_at END
     RETURNING count`,
    [key, WINDOW_MINUTES]
  );

  return row.count > MAX_ATTEMPTS;
}

// ---------- Routes ----------

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const authRouter = express.Router();

authRouter.post("/register", async (req, res, next) => {
  try {
    const email = String(req.body.email || "").trim().toLowerCase();
    const name = String(req.body.name || "").trim();
    const password = String(req.body.password || "");

    if (!EMAIL_RE.test(email) || email.length > 200) {
      return res.status(400).json({ message: "Enter a valid email address." });
    }

    if (!name || name.length > 80) {
      return res.status(400).json({ message: "Enter your name." });
    }

    if (password.length < 8 || password.length > 200) {
      return res.status(400).json({ message: "Password must be at least 8 characters." });
    }

    if (await tooManyAttempts(`register:${req.ip}`)) {
      return res.status(429).json({ message: "Too many attempts. Please try again later." });
    }

    // Free uses made before signing up carry over to the account.
    const user = await createUser({
      email,
      name,
      password,
      freeUses: req.visitor?.free_uses ?? 0,
    });

    await startSession(req, res, user.id);
    res.status(201).json({ user: publicUser(user) });
  } catch (error) {
    next(error);
  }
});

authRouter.post("/login", async (req, res, next) => {
  try {
    const email = String(req.body.email || "").trim().toLowerCase();
    const password = String(req.body.password || "");

    const blocked =
      (await tooManyAttempts(`login:${req.ip}`)) |
      (await tooManyAttempts(`login:${email}`));

    if (blocked) {
      return res.status(429).json({ message: "Too many login attempts. Please wait 15 minutes." });
    }

    const user = await one("SELECT * FROM users WHERE email = $1", [email]);
    const valid = await verifyPassword(password, user?.password_hash || DUMMY_HASH);

    if (!user || !valid) {
      return res.status(401).json({ message: "Incorrect email or password." });
    }

    await startSession(req, res, user.id);
    res.json({ user: publicUser(user) });
  } catch (error) {
    next(error);
  }
});

authRouter.post("/logout", async (req, res, next) => {
  try {
    const token = readCookie(req, SESSION_COOKIE);

    if (token) {
      await query("DELETE FROM sessions WHERE token_hash = $1", [hashToken(token)]);
    }

    setSessionCookie(req, res, "", 0);
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});
