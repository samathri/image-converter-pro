// Sign-in is handled by Clerk (email codes, Google, forgot password).
// Each Clerk user is linked to a row in our users table, which holds the
// plan, role, payments and referrals.
import crypto from "crypto";
import { clerkClient, clerkMiddleware, getAuth } from "@clerk/express";
import { one, toIso } from "./db.js";

export const PUBLISHABLE_KEY =
  process.env.CLERK_PUBLISHABLE_KEY || process.env.VITE_CLERK_PUBLISHABLE_KEY || "";

export const clerkConfigured = Boolean(PUBLISHABLE_KEY && process.env.CLERK_SECRET_KEY);

if (!clerkConfigured) {
  console.warn("[auth] Set VITE_CLERK_PUBLISHABLE_KEY and CLERK_SECRET_KEY to turn on sign-in.");
}

// Reads the Clerk session (cookie or Bearer token). A no-op without keys.
export const clerkAuth = clerkConfigured
  ? clerkMiddleware({ publishableKey: PUBLISHABLE_KEY })
  : (req, res, next) => next();

// ---------- Users ----------

function newPayRef() {
  // No 0/O/1/I so it's easy to type into a bank transfer.
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.randomBytes(6);

  return "ICP-" + Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
}

// The account in ADMIN_EMAIL is the site owner and is always an admin.
export function ownerEmail() {
  return String(process.env.ADMIN_EMAIL || "").trim().toLowerCase();
}

async function insertUser({ email, name, clerkId, role, freeUses }) {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      return await one(
        `INSERT INTO users (email, name, clerk_id, role, pay_ref, free_uses)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
        [email, name, clerkId, role, newPayRef(), freeUses]
      );
    } catch (error) {
      if (error.code !== "23505") throw error;
      // email/clerk_id taken: another request created it first
      if (!String(error.constraint || error.message).includes("pay_ref")) return null;
    }
  }

  throw new Error("Could not create account. Please try again.");
}

// Finds (or creates) our user row for a Clerk user.
async function userForClerk(req, clerkId) {
  let user = await one("SELECT * FROM users WHERE clerk_id = $1", [clerkId]);

  if (!user) {
    const profile = await clerkClient.users.getUser(clerkId);
    const primary = profile.emailAddresses.find((e) => e.id === profile.primaryEmailAddressId);

    if (!primary || primary.verification?.status !== "verified") return null;

    const email = primary.emailAddress.trim().toLowerCase();
    const name =
      [profile.firstName, profile.lastName].filter(Boolean).join(" ").trim().slice(0, 80) ||
      email.split("@")[0];

    // An account from before Clerk (same email) keeps its plan and history.
    user = await one("UPDATE users SET clerk_id = $1 WHERE email = $2 AND clerk_id IS NULL RETURNING *", [
      clerkId,
      email,
    ]);

    if (!user) {
      user = await insertUser({
        email,
        name,
        clerkId,
        role: email === ownerEmail() ? "admin" : "user",
        freeUses: req.visitor?.free_uses ?? 0,
      });

      if (user) {
        await referralHook(req, user);
      } else {
        user = await one("SELECT * FROM users WHERE clerk_id = $1", [clerkId]);
      }
    }
  }

  if (user && user.role !== "admin" && ownerEmail() && user.email === ownerEmail()) {
    user = await one("UPDATE users SET role = 'admin' WHERE id = $1 RETURNING *", [user.id]);
  }

  return user;
}

export function getUserById(id) {
  return one("SELECT * FROM users WHERE id = $1", [id]);
}

/** Removes the user's Clerk login too, so they can't sign straight back in. */
export async function deleteClerkUser(user) {
  if (!clerkConfigured || !user.clerk_id) return;

  try {
    await clerkClient.users.deleteUser(user.clerk_id);
  } catch (error) {
    if (error.status !== 404) throw error;
  }
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
    createdAt: toIso(user.created_at),
    proUntil: !isAdmin(user) && isPro(user) ? toIso(user.pro_until) : null,
  };
}

// ---------- Cookies ----------

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

// ---------- Middleware ----------

// Attaches req.user when the request has a valid Clerk session.
export async function loadUser(req, res, next) {
  try {
    const userId = clerkConfigured ? getAuth(req).userId : null;

    req.user = userId ? await userForClerk(req, userId) : null;
    next();
  } catch (error) {
    next(error);
  }
}

export function requireUser(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ message: "Please sign in first." });
  }

  next();
}

export function requireAdmin(req, res, next) {
  if (req.user?.role !== "admin") {
    return res.status(req.user ? 403 : 401).json({ message: "Admin access required." });
  }

  next();
}

// Referral rewards for new accounts are hooked in from promotions.js.
let referralHook = async () => {};

export function setReferralHook(fn) {
  referralHook = fn;
}
