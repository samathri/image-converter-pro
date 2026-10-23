import crypto from "crypto";
import net from "net";
import { getSettings, one, toIso, transaction } from "./db.js";
import { cookieFlags, isAdmin, isPro, publicUser, readCookie } from "./auth.js";
import { secret } from "./secret.js";
import { activeCampaign, campaignView, canInvite } from "./promotions.js";

export const FREE_USES = 3;
export const FREE_MAX_IMAGES = 5;
export const PRO_MAX_IMAGES = 50;

const VISITOR_COOKIE = "icp_vid";
const COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

function hmac(value) {
  return crypto.createHmac("sha256", secret()).update(value).digest("base64url");
}

function readVisitorCookie(req) {
  const raw = readCookie(req, VISITOR_COOKIE);

  if (!raw) return null;

  const [id, signature] = raw.split(".");

  if (!id || !signature) return null;

  const expected = hmac(id);

  if (
    signature.length !== expected.length ||
    !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
  ) {
    return null;
  }

  return id;
}

// Gives every browser a signed, anonymous visitor id.
export async function identify(req, res, next) {
  try {
    let id = readVisitorCookie(req);

    if (!id) {
      id = crypto.randomUUID();

      res.append(
        "Set-Cookie",
        [
          `${VISITOR_COOKIE}=${encodeURIComponent(`${id}.${hmac(id)}`)}`,
          ...cookieFlags(req),
          `Max-Age=${COOKIE_MAX_AGE}`,
        ].join("; ")
      );
    }

    req.visitorId = id;
    req.visitor = (await one("SELECT * FROM visitors WHERE id = $1", [id])) || null;
    next();
  } catch (error) {
    next(error);
  }
}

// Loopback/private addresses usually mean a proxy that isn't trusted;
// counting those would lock out everyone at once.
function isPublicIp(ip) {
  if (!ip) return false;

  const address = ip.replace(/^::ffff:/, "");

  if (net.isIPv4(address)) {
    const [a, b] = address.split(".").map(Number);

    return !(
      a === 10 ||
      a === 127 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254)
    );
  }

  return !(
    address === "::1" ||
    address.startsWith("fc") ||
    address.startsWith("fd") ||
    address.startsWith("fe80")
  );
}

function ipKey(req) {
  return isPublicIp(req.ip) ? hmac(`ip:${req.ip}`) : null;
}

// Free uses = the highest count across this browser, this account and
// this IP, so clearing cookies or signing up again doesn't reset it.
async function freeUsesFor(req) {
  const counts = [req.visitor?.free_uses ?? 0, req.user?.free_uses ?? 0];
  const key = ipKey(req);

  if (key) {
    const row = await one("SELECT free_uses FROM ip_usage WHERE ip_hash = $1", [key]);
    counts.push(row?.free_uses ?? 0);
  }

  return Math.max(...counts);
}

async function adjustFreeUses(req, delta) {
  await transaction(async (q) => {
    await q(
      `INSERT INTO visitors (id, free_uses) VALUES ($1, GREATEST(0, $2))
       ON CONFLICT (id) DO UPDATE SET free_uses = GREATEST(0, visitors.free_uses + $2)`,
      [req.visitorId, delta]
    );

    if (req.user) {
      await q("UPDATE users SET free_uses = GREATEST(0, free_uses + $1) WHERE id = $2", [delta, req.user.id]);
    }

    const key = ipKey(req);

    if (key) {
      await q(
        `INSERT INTO ip_usage (ip_hash, free_uses) VALUES ($1, GREATEST(0, $2))
         ON CONFLICT (ip_hash) DO UPDATE SET free_uses = GREATEST(0, ip_usage.free_uses + $2)`,
        [key, delta]
      );
    }
  });
}

// 3 free conversions, plus any bonus from a friend's invite.
function freeLimit(req) {
  return FREE_USES + (req.user?.bonus_uses ?? 0);
}

function latestPayment(userId) {
  return one(
    `SELECT id, status, method, admin_note, created_at, reviewed_at FROM payments
     WHERE user_id = $1 AND status NOT IN ('awaiting_payment', 'cancelled', 'failed')
     ORDER BY id DESC LIMIT 1`,
    [userId]
  );
}

export async function getAccount(req) {
  const settings = await getSettings();
  const pro = isPro(req.user);
  const admin = isAdmin(req.user);
  const payment = req.user ? await latestPayment(req.user.id) : null;
  const used = pro ? 0 : await freeUsesFor(req);
  const campaign = await activeCampaign();

  return {
    user: publicUser(req.user),
    plan: pro ? "pro" : "free",
    admin, // admins have unlimited access without a Pro period
    freeUses: freeLimit(req),
    usesLeft: pro ? null : Math.max(0, freeLimit(req) - used),
    maxImages: pro ? PRO_MAX_IMAGES : FREE_MAX_IMAGES,
    proMaxImages: PRO_MAX_IMAGES,
    proUntil: pro && !admin ? toIso(req.user.pro_until) : null,
    // Set for 30 days after a Pro plan ends, so the app can offer a renewal.
    proEndedAt:
      !pro && req.user?.pro_until && Date.now() - new Date(req.user.pro_until) < 30 * 864e5
        ? toIso(req.user.pro_until)
        : null,
    price: settings.price,
    currency: settings.currency,
    campaign: campaignView(campaign),
    canInvite: await canInvite(req.user),
    latestPayment: payment
      ? {
          id: payment.id,
          status: payment.status,
          method: payment.method,
          adminNote: payment.admin_note,
          createdAt: toIso(payment.created_at),
          reviewedAt: toIso(payment.reviewed_at),
        }
      : null,
  };
}

/** Whether this visitor may start a conversion at all (used before uploads). */
export async function canConvert(req) {
  return isPro(req.user) || (await freeUsesFor(req)) < freeLimit(req);
}

/**
 * Checks plan limits and reserves one free use.
 * Returns { ok: true, release } or { ok: false, status, code, message }.
 * Call release() if the conversion fails so the use is refunded.
 */
export async function reserveUse(req, imageCount) {
  if (isPro(req.user)) {
    if (imageCount > PRO_MAX_IMAGES) {
      return {
        ok: false,
        status: 400,
        code: "PRO_LIMIT",
        message: `Pro allows up to ${PRO_MAX_IMAGES} images per batch.`,
      };
    }

    return { ok: true, release: async () => {} };
  }

  if ((await freeUsesFor(req)) >= freeLimit(req)) {
    return {
      ok: false,
      status: 402,
      code: "QUOTA_EXHAUSTED",
      message: `You've used all ${freeLimit(req)} free conversions. Upgrade to Pro to keep converting.`,
    };
  }

  if (imageCount > FREE_MAX_IMAGES) {
    return {
      ok: false,
      status: 402,
      code: "TOO_MANY_IMAGES",
      message: `Free conversions are limited to ${FREE_MAX_IMAGES} images. Upgrade to Pro to convert more at once.`,
    };
  }

  await adjustFreeUses(req, 1);

  let released = false;

  return {
    ok: true,
    release: async () => {
      if (released) return;
      released = true;
      await adjustFreeUses(req, -1);
    },
  };
}
