import crypto from "crypto";
import { promisify } from "util";
import express from "express";
import { one, query, toIso, transaction } from "./db.js";
import { sendCodeEmail } from "./mailer.js";
import { secret } from "./secret.js";

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

export async function createUser({ email, name, password, passwordHash, role = "user", freeUses = 0 }) {
  passwordHash ??= await hashPassword(password);

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

// ---------- Email codes (signup verification, password reset) ----------

const CODE_MINUTES = 10;
const CODE_MAX_ATTEMPTS = 5;
const CODE_RESEND_SECONDS = 60;

function hashCode(email, purpose, code) {
  return crypto.createHmac("sha256", secret()).update(`${purpose}:${email}:${code}`).digest("hex");
}

async function issueCode(email, purpose, payload = null) {
  const recent = await one(
    `SELECT id FROM email_codes WHERE email = $1 AND purpose = $2
     AND created_at > now() - make_interval(secs => $3)`,
    [email, purpose, CODE_RESEND_SECONDS]
  );

  if (recent) {
    throw Object.assign(new Error("A code was just sent. Please wait a minute before asking for another."), { status: 429 });
  }

  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");

  await transaction(async (q) => {
    await q("DELETE FROM email_codes WHERE email = $1 AND purpose = $2", [email, purpose]);
    await q(
      `INSERT INTO email_codes (email, purpose, code_hash, payload, expires_at)
       VALUES ($1, $2, $3, $4, now() + make_interval(mins => $5))`,
      [email, purpose, hashCode(email, purpose, code), payload && JSON.stringify(payload), CODE_MINUTES]
    );
  });

  return code;
}

/** Checks a code; returns its payload on success. Wrong codes count as attempts. */
async function consumeCode(email, purpose, code) {
  const row = await one(
    "SELECT * FROM email_codes WHERE email = $1 AND purpose = $2 ORDER BY id DESC LIMIT 1",
    [email, purpose]
  );

  const invalid = (message = "That code isn't right. Check the email and try again.") =>
    Object.assign(new Error(message), { status: 400 });

  if (!row || new Date(row.expires_at) < new Date()) throw invalid("That code has expired. Ask for a new one.");
  if (row.attempts >= CODE_MAX_ATTEMPTS) throw invalid("Too many wrong tries. Ask for a new code.");

  const expected = Buffer.from(row.code_hash);
  const given = Buffer.from(hashCode(email, purpose, String(code || "").trim()));

  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) {
    await one("UPDATE email_codes SET attempts = attempts + 1 WHERE id = $1", [row.id]);
    throw invalid();
  }

  await one("DELETE FROM email_codes WHERE email = $1 AND purpose = $2", [email, purpose]);
  return row.payload ? JSON.parse(row.payload) : null;
}

// ---------- Routes ----------

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const httpError = (status, message) => Object.assign(new Error(message), { status });

const readEmail = (body) => String(body.email || "").trim().toLowerCase();

function checkPassword(password) {
  if (password.length < 8 || password.length > 200) {
    throw httpError(400, "Password must be at least 8 characters.");
  }
}

export const authRouter = express.Router();

// Step 1 of signup: check the details and email a verification code.
authRouter.post("/register", async (req, res, next) => {
  try {
    const email = readEmail(req.body);
    const name = String(req.body.name || "").trim();
    const password = String(req.body.password || "");

    if (!EMAIL_RE.test(email) || email.length > 200) throw httpError(400, "Enter a valid email address.");
    if (!name || name.length > 80) throw httpError(400, "Enter your name.");
    checkPassword(password);

    if (await tooManyAttempts(`register:${req.ip}`)) {
      throw httpError(429, "Too many attempts. Please try again later.");
    }

    if (await one("SELECT id FROM users WHERE email = $1", [email])) {
      throw httpError(409, "An account with this email already exists. Sign in instead.");
    }

    const code = await issueCode(email, "signup", { name, passwordHash: await hashPassword(password) });

    await sendCodeEmail(email, {
      title: "Verify your email",
      intro: `Hi ${name}, enter this code to finish creating your Image Converter Pro account.`,
      code,
    });

    res.json({ verify: true, email });
  } catch (error) {
    next(error);
  }
});

// Step 2 of signup: the code from the email creates the account.
authRouter.post("/register/verify", async (req, res, next) => {
  try {
    const email = readEmail(req.body);
    const payload = await consumeCode(email, "signup", req.body.code);

    if (await one("SELECT id FROM users WHERE email = $1", [email])) {
      throw httpError(409, "An account with this email already exists. Sign in instead.");
    }

    const user = await createUser({
      email,
      name: payload.name,
      passwordHash: payload.passwordHash,
      freeUses: req.visitor?.free_uses ?? 0,
    });

    await applyReferral(req, user);
    await startSession(req, res, user.id);
    res.status(201).json({ user: publicUser(user) });
  } catch (error) {
    next(error);
  }
});

authRouter.post("/login", async (req, res, next) => {
  try {
    const email = readEmail(req.body);
    const password = String(req.body.password || "");

    const blocked =
      (await tooManyAttempts(`login:${req.ip}`)) |
      (await tooManyAttempts(`login:${email}`));

    if (blocked) throw httpError(429, "Too many login attempts. Please wait 15 minutes.");

    const user = await one("SELECT * FROM users WHERE email = $1", [email]);
    const valid = await verifyPassword(password, user?.password_hash || DUMMY_HASH);

    if (!user || !valid) throw httpError(401, "Incorrect email or password.");

    await startSession(req, res, user.id);
    res.json({ user: publicUser(user) });
  } catch (error) {
    next(error);
  }
});

// Forgot password: email a reset code (same answer whether or not the email exists).
authRouter.post("/password/forgot", async (req, res, next) => {
  try {
    const email = readEmail(req.body);

    if (!EMAIL_RE.test(email)) throw httpError(400, "Enter a valid email address.");

    if (await tooManyAttempts(`forgot:${req.ip}`)) {
      throw httpError(429, "Too many attempts. Please try again later.");
    }

    const user = await one("SELECT name FROM users WHERE email = $1", [email]);

    if (user) {
      const code = await issueCode(email, "reset");

      await sendCodeEmail(email, {
        title: "Reset your password",
        intro: `Hi ${user.name}, enter this code to choose a new password.`,
        code,
      });
    }

    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

authRouter.post("/password/reset", async (req, res, next) => {
  try {
    const email = readEmail(req.body);
    const password = String(req.body.password || "");

    checkPassword(password);
    await consumeCode(email, "reset", req.body.code);

    const user = await one("SELECT * FROM users WHERE email = $1", [email]);

    if (!user) throw httpError(400, "That code has expired. Ask for a new one.");

    await query("UPDATE users SET password_hash = $1 WHERE id = $2", [await hashPassword(password), user.id]);
    // Sign out everywhere else, then sign in here.
    await query("DELETE FROM sessions WHERE user_id = $1", [user.id]);
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

// ---------- Google sign-in (OAuth 2.0) ----------

const OAUTH_COOKIE = "icp_oauth";

const PROVIDERS = {
  google: {
    clientId: process.env.GOOGLE_CLIENT_ID || "",
    clientSecret: process.env.GOOGLE_CLIENT_SECRET || "",
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    scope: "openid email profile",
    pkce: true,
  },
};

const configured = (name) => Boolean(PROVIDERS[name]?.clientId && PROVIDERS[name]?.clientSecret);

export function oauthProviders() {
  return { google: configured("google") };
}

function publicUrl(req) {
  const fromEnv =
    process.env.PUBLIC_URL ||
    (process.env.VERCEL_PROJECT_PRODUCTION_URL && `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`);

  return (fromEnv || `${req.protocol}://${req.get("host")}`).replace(/\/+$/, "");
}

const callbackUrl = (req, provider) => `${publicUrl(req)}/api/auth/oauth/${provider}/callback`;

function signValue(value) {
  return crypto.createHmac("sha256", secret()).update(value).digest("base64url");
}

authRouter.get("/providers", (req, res) => {
  res.json(oauthProviders());
});

// Sends the browser to Google.
authRouter.get("/oauth/:provider", (req, res) => {
  const name = req.params.provider;
  const provider = PROVIDERS[name];

  if (!provider || !configured(name)) {
    return res.redirect("/?auth_error=" + encodeURIComponent("That sign-in option isn't available."));
  }

  const state = crypto.randomBytes(16).toString("base64url");
  const verifier = crypto.randomBytes(32).toString("base64url");
  // "upgrade" = the user started from a Buy Pro button: reopen billing afterwards.
  const next = req.query.next === "upgrade" ? "upgrade" : "home";
  const value = `${name}.${state}.${verifier}.${next}`;

  // Remember state (and the PKCE verifier) in a short-lived signed cookie.
  res.append("Set-Cookie", [`${OAUTH_COOKIE}=${value}.${signValue(value)}`, ...cookieFlags(req), "Max-Age=600"].join("; "));

  const params = new URLSearchParams({
    client_id: provider.clientId,
    redirect_uri: callbackUrl(req, name),
    response_type: "code",
    scope: provider.scope,
    state,
  });

  if (provider.pkce) {
    params.set("code_challenge", crypto.createHash("sha256").update(verifier).digest("base64url"));
    params.set("code_challenge_method", "S256");
    params.set("prompt", "select_account");
  }

  res.redirect(`${provider.authorizeUrl}?${params}`);
});

async function fetchProfile(name, provider, req, code, verifier) {
  if (name === "google") {
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: provider.clientId,
        client_secret: provider.clientSecret,
        redirect_uri: callbackUrl(req, name),
        grant_type: "authorization_code",
        code_verifier: verifier,
      }),
    });
    const token = await tokenRes.json();

    if (!tokenRes.ok) throw new Error(`token exchange failed: ${JSON.stringify(token)}`);

    const info = await (
      await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
        headers: { Authorization: `Bearer ${token.access_token}` },
      })
    ).json();

    if (!info.email || info.email_verified !== true) {
      throw Object.assign(new Error("Your Google account's email isn't verified."), { public: true });
    }

    return { id: info.sub, email: info.email, name: info.name || info.email.split("@")[0] };
  }

  throw new Error(`unknown provider ${name}`);
}

// Google sends the browser back here.
authRouter.get("/oauth/:provider/callback", async (req, res) => {
  const name = req.params.provider;
  const provider = PROVIDERS[name];
  const fail = (message) => res.redirect("/?auth_error=" + encodeURIComponent(message));

  res.append("Set-Cookie", [`${OAUTH_COOKIE}=`, ...cookieFlags(req), "Max-Age=0"].join("; "));

  try {
    if (!provider || !configured(name)) return fail("That sign-in option isn't available.");
    if (req.query.error) return fail("Sign-in was cancelled.");

    const raw = readCookie(req, OAUTH_COOKIE) || "";
    const [cookieProvider, state, verifier, next, signature] = raw.split(".");
    const value = `${cookieProvider}.${state}.${verifier}.${next}`;

    if (cookieProvider !== name || !state || state !== req.query.state || signature !== signValue(value)) {
      return fail("Sign-in expired. Please try again.");
    }

    const profile = await fetchProfile(name, provider, req, String(req.query.code || ""), verifier);
    const email = profile.email.trim().toLowerCase();

    // Existing link → that user; otherwise match by email; otherwise a new account.
    let user = await one(
      "SELECT u.* FROM oauth_accounts o JOIN users u ON u.id = o.user_id WHERE o.provider = $1 AND o.provider_user_id = $2",
      [name, profile.id]
    );

    if (!user) user = await one("SELECT * FROM users WHERE email = $1", [email]);

    const isNew = !user;

    if (!user) {
      user = await createUser({
        email,
        name: profile.name.slice(0, 80),
        passwordHash: "oauth$none", // no password yet; "Forgot password" can set one
        freeUses: req.visitor?.free_uses ?? 0,
      });
      await applyReferral(req, user);
    }

    await one(
      `INSERT INTO oauth_accounts (provider, provider_user_id, user_id) VALUES ($1, $2, $3)
       ON CONFLICT (provider, provider_user_id) DO NOTHING`,
      [name, profile.id, user.id]
    );

    await startSession(req, res, user.id);
    // New accounts (and sign-ins from a Buy Pro button) land on the purchase window.
    const wantsPro = (isNew || next === "upgrade") && !isPro(user);

    res.redirect(user.role === "admin" ? "/admin" : wantsPro ? "/?upgrade=1" : "/");
  } catch (error) {
    console.error(`[oauth:${name}]`, error.message);
    fail(error.public ? error.message : "Sign-in failed. Please try again.");
  }
});

// Referral rewards for new accounts are hooked in from referrals.js.
let referralHook = async () => {};

export function setReferralHook(fn) {
  referralHook = fn;
}

function applyReferral(req, user) {
  return referralHook(req, user);
}
