// Offers: sale campaigns, promo codes and the referral programme.
// All prices are worked out here, on the server, so the browser can't
// change what a user pays.
import crypto from "crypto";
import express from "express";
import { getSettings, one, query, saveSettings, toIso, transaction } from "./db.js";
import { cookieFlags, isAdmin, readCookie, requireAdmin, requireUser, setReferralHook } from "./auth.js";
import { extendPro, PLAN_MONTHS } from "./plans.js";

const REF_COOKIE = "icp_ref";
const httpError = (status, message) => Object.assign(new Error(message), { status });
const round2 = (n) => Math.round(Number(n) * 100) / 100;

// ---------- Settings ----------

export async function referralSettings(q) {
  const s = await getSettings(q);

  return {
    enabled: s.referralEnabled !== "false",
    friendsPerReward: Math.min(100, Math.max(1, Math.round(Number(s.referralFriendsPerReward) || 5))),
    rewardPercent: Math.min(90, Math.max(0, Number(s.referralRewardPercent) || 0)),
  };
}

/** Only users who have bought a plan can invite friends. */
export async function canInvite(user) {
  if (!user || user.role !== "user") return false;

  return Boolean(
    await one("SELECT id FROM payments WHERE user_id = $1 AND status = 'approved' LIMIT 1", [user.id])
  );
}

/**
 * Referral rewards: one "X% off your next payment" for every N friends who
 * joined with the user's link. Rewards held by payments still in progress
 * count as taken, so one reward can't be used twice.
 */
export async function referralRewards(userId) {
  const ref = await referralSettings();
  const row = await one(
    `SELECT
       (SELECT COUNT(*)::int FROM users WHERE referred_by = $1) AS joined,
       (SELECT referral_rewards_used FROM users WHERE id = $1) AS used,
       (SELECT COUNT(*)::int FROM payments WHERE user_id = $1 AND reward_applied
          AND (status = 'pending' OR (status = 'awaiting_payment' AND created_at > now() - interval '6 hours'))) AS reserved`,
    [userId]
  );
  const earned = Math.floor(row.joined / ref.friendsPerReward);

  return {
    ...ref,
    joined: row.joined,
    earned,
    used: row.used ?? 0,
    available: ref.enabled ? Math.max(0, earned - (row.used ?? 0) - row.reserved) : 0,
    towardNext: row.joined % ref.friendsPerReward,
  };
}

// ---------- Campaigns ----------

/** The active sale with the biggest discount right now, if any. */
export function activeCampaign() {
  return one(
    `SELECT * FROM campaigns
     WHERE active AND (starts_at IS NULL OR starts_at <= now()) AND (ends_at IS NULL OR ends_at > now())
     ORDER BY discount_percent DESC, id DESC LIMIT 1`
  );
}

export function campaignView(c) {
  return c
    ? {
        id: c.id,
        name: c.name,
        banner: c.banner,
        discountPercent: Number(c.discount_percent),
        endsAt: toIso(c.ends_at),
      }
    : null;
}

// ---------- Promo codes ----------

async function findPromo(code, user) {
  const normalized = String(code || "").trim().toUpperCase();

  if (!normalized) return null;

  const promo = await one("SELECT * FROM promo_codes WHERE code = $1", [normalized]);
  const invalid = (msg) => httpError(400, msg);

  if (!promo || !promo.active) throw invalid("That promo code isn't valid.");
  if (promo.starts_at && new Date(promo.starts_at) > new Date()) throw invalid("That promo code isn't active yet.");
  if (promo.ends_at && new Date(promo.ends_at) <= new Date()) throw invalid("That promo code has expired.");
  if (promo.max_uses !== null && promo.used_count >= promo.max_uses) throw invalid("That promo code has been fully used.");

  if (user) {
    const used = await one(
      "SELECT id FROM payments WHERE user_id = $1 AND promo_code_id = $2 AND status = 'approved'",
      [user.id, promo.id]
    );

    if (used) throw invalid("You've already used that promo code.");
  }

  return promo;
}

// ---------- Prices ----------

/** % off for longer plans, e.g. { 1: 0, 3: 10, 6: 15, 12: 25 }. */
export async function planDiscounts(q) {
  const s = await getSettings(q);
  const pct = (v) => Math.min(90, Math.max(0, Number(v) || 0));

  return { 1: 0, 3: pct(s.planDiscount3), 6: pct(s.planDiscount6), 12: pct(s.planDiscount12) };
}

/**
 * Works out what a user pays for `months` of Pro:
 * 1. plan price = monthly price x months, minus the longer-plan discount;
 * 2. then the single best of: sale campaign, promo code, invite discount.
 */
export async function quote(user, months, promoCode) {
  if (!PLAN_MONTHS.includes(Number(months))) throw httpError(400, "Choose a valid plan length.");

  const settings = await getSettings();
  const listAmount = round2(settings.price * months);
  const lines = [];

  // 1. Longer-plan discount
  const planPercent = (await planDiscounts())[months] || 0;
  const planDiscount = round2((listAmount * planPercent) / 100);

  if (planDiscount > 0) {
    lines.push({ kind: "plan", label: `${months}-month plan (${planPercent}% off)`, amount: planDiscount });
  }

  const base = round2(listAmount - planDiscount);
  const options = [];

  // 2. Best of campaign / promo / invite, on the plan price
  const campaign = await activeCampaign();

  if (campaign) {
    options.push({
      kind: "campaign",
      label: `${campaign.name} (${Number(campaign.discount_percent)}% off)`,
      amount: round2((base * Number(campaign.discount_percent)) / 100),
      campaignId: campaign.id,
    });
  }

  const promo = await findPromo(promoCode, user);

  if (promo) {
    const amount = promo.kind === "percent" ? (base * Number(promo.value)) / 100 : Number(promo.value);

    options.push({
      kind: "promo",
      label: promo.kind === "percent" ? `Code ${promo.code} (${Number(promo.value)}% off)` : `Code ${promo.code}`,
      amount: round2(Math.min(base, amount)),
      promoCodeId: promo.id,
    });
  }

  const best = options.sort((a, b) => b.amount - a.amount)[0] || null;

  if (best && best.amount > 0) lines.push({ kind: best.kind, label: best.label, amount: Math.min(base, best.amount) });

  // 3. A referral reward the user earned (5 friends = 5% off), on top of everything.
  let rewardApplied = false;

  if (user) {
    const rewards = await referralRewards(user.id);
    const remaining = round2(listAmount - lines.reduce((sum, l) => sum + l.amount, 0));

    if (rewards.available > 0 && rewards.rewardPercent > 0 && remaining > 0) {
      lines.push({
        kind: "reward",
        label: `Referral reward (${rewards.rewardPercent}% off)`,
        amount: round2((remaining * rewards.rewardPercent) / 100),
      });
      rewardApplied = true;
    }
  }

  const discount = round2(lines.reduce((sum, l) => sum + l.amount, 0));

  return {
    months: Number(months),
    currency: settings.currency,
    listAmount,
    lines, // each discount, for the price breakdown
    planPercent,
    discount, // total of all discounts (stored with the payment)
    discountLabel: lines.map((l) => l.label).join(" + ") || null,
    discountKind: best?.kind || null,
    total: round2(Math.max(0, listAmount - discount)),
    promoCodeId: best?.kind === "promo" ? best.promoCodeId : null,
    campaignId: best?.kind === "campaign" ? best.campaignId : null,
    promoApplied: Boolean(promo),
    promoBeaten: Boolean(promo) && best?.kind !== "promo",
    rewardApplied, // stored with the payment; the reward is used up when it's approved
  };
}

/** Columns to store with a new payment so the price can be audited later. */
export function quoteColumns(q) {
  return {
    list_amount: q.listAmount,
    discount_amount: q.discount,
    expected_amount: q.total,
    promo_code_id: q.promoCodeId,
    campaign_id: q.campaignId,
    discount_label: q.discountLabel,
  };
}

// ---------- After a payment is approved ----------

/**
 * Called inside the approving transaction (bank approval, PayPal, PayHere,
 * free claim): counts the promo code use and rewards the referrer once.
 */
export async function onPaymentApproved(q, payment) {
  if (payment.promo_code_id) {
    await q("UPDATE promo_codes SET used_count = used_count + 1 WHERE id = $1", [payment.promo_code_id]);
  }

  if (payment.reward_applied) {
    await q("UPDATE users SET referral_rewards_used = referral_rewards_used + 1 WHERE id = $1", [payment.user_id]);
  }

  // For the admin stats: an invited user has paid.
  await q("UPDATE users SET referral_rewarded = true WHERE id = $1 AND referred_by IS NOT NULL", [payment.user_id]);
}

// ---------- Referral codes ----------

async function ensureReferralCode(user) {
  if (user.referral_code) return user.referral_code;

  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

  for (let i = 0; i < 5; i++) {
    const code = Array.from(crypto.randomBytes(7), (b) => alphabet[b % alphabet.length]).join("");
    const row = await one(
      "UPDATE users SET referral_code = $1 WHERE id = $2 AND referral_code IS NULL RETURNING referral_code",
      [code, user.id]
    ).catch((error) => {
      if (error.code === "23505") return null; // code taken, try another
      throw error;
    });

    if (row) return row.referral_code;

    const existing = await one("SELECT referral_code FROM users WHERE id = $1", [user.id]);

    if (existing?.referral_code) return existing.referral_code;
  }

  throw new Error("Could not create a referral code.");
}

// New accounts: link to the referrer from the invite cookie and give the bonus.
setReferralHook(async (req, user) => {
  const code = String(readCookie(req, REF_COOKIE) || "").toUpperCase();

  if (!code) return;

  const ref = await referralSettings();

  if (!ref.enabled) return;

  const referrer = await one("SELECT * FROM users WHERE referral_code = $1", [code]);

  if (!referrer || referrer.id === user.id || !(await canInvite(referrer))) return;

  await one("UPDATE users SET referred_by = $1 WHERE id = $2", [referrer.id, user.id]);

  req.res?.append("Set-Cookie", [`${REF_COOKIE}=`, ...cookieFlags(req), "Max-Age=0"].join("; "));
});

// ---------- User routes ----------

export const promoRouter = express.Router();

// Remembers who invited this visitor (from a ?ref=CODE link) for 30 days.
promoRouter.post("/referral/visit", async (req, res, next) => {
  try {
    const code = String(req.body.code || "").trim().toUpperCase();

    const referrer = /^[A-Z0-9]{4,20}$/.test(code)
      ? await one("SELECT * FROM users WHERE referral_code = $1", [code])
      : null;

    if (referrer && (await canInvite(referrer))) {
      res.append("Set-Cookie", [`${REF_COOKIE}=${code}`, ...cookieFlags(req), `Max-Age=${30 * 86400}`].join("; "));
      return res.json({ ok: true });
    }

    res.json({ ok: false });
  } catch (error) {
    next(error);
  }
});

promoRouter.get("/referral", requireUser, async (req, res, next) => {
  try {
    if (!(await canInvite(req.user))) {
      return res.json({ eligible: false });
    }

    res.json({
      eligible: true,
      code: await ensureReferralCode(req.user),
      ...(await referralRewards(req.user.id)),
    });
  } catch (error) {
    next(error);
  }
});

promoRouter.get("/quote", requireUser, async (req, res, next) => {
  try {
    res.json(await quote(req.user, Number(req.query.months), req.query.code));
  } catch (error) {
    next(error);
  }
});

// A promo code that makes Pro free: activate it straight away.
promoRouter.post("/claim-free", requireUser, async (req, res, next) => {
  try {
    if (isAdmin(req.user)) throw httpError(400, "Admin accounts already have full access.");

    const q = await quote(req.user, Number(req.body.months), req.body.code);

    if (q.total > 0) throw httpError(400, "This plan isn't free. Please choose a payment method.");

    const until = await transaction(async (t) => {
      const [payment] = await t(
        `INSERT INTO payments (user_id, amount, currency, months, method, status, transaction_ref, paid_on,
           reviewed_at, admin_note, list_amount, discount_amount, expected_amount, promo_code_id, campaign_id, discount_label, reward_applied)
         VALUES ($1, 0, $2, $3, 'promo', 'approved', $4, to_char(now(), 'YYYY-MM-DD'), now(), 'Free with promo code',
           $5, $6, 0, $7, $8, $9, $10) RETURNING *`,
        [req.user.id, q.currency, q.months, q.discountLabel, q.listAmount, q.discount, q.promoCodeId, q.campaignId, q.discountLabel, q.rewardApplied]
      );

      await onPaymentApproved(t, payment);
      return extendPro(req.user.id, q.months, t);
    });

    res.json({ status: "approved", proUntil: until });
  } catch (error) {
    next(error);
  }
});

// ---------- Admin routes ----------

export const promoAdminRouter = express.Router();

promoAdminRouter.use(requireAdmin);

const dateOrNull = (v) => {
  if (!v) return null;
  const d = new Date(v);

  if (Number.isNaN(d.getTime())) throw httpError(400, "Enter valid dates.");
  return d;
};

promoAdminRouter.get("/", async (req, res, next) => {
  try {
    const [campaigns, codes, ref, refStats, topReferrers, plans] = await Promise.all([
      query("SELECT * FROM campaigns ORDER BY id DESC"),
      query("SELECT * FROM promo_codes ORDER BY id DESC"),
      referralSettings(),
      one(
        `SELECT COUNT(*) FILTER (WHERE referred_by IS NOT NULL)::int AS signups,
                COUNT(*) FILTER (WHERE referral_rewarded)::int AS rewarded
         FROM users`
      ),
      query(
        `SELECT r.name, r.email, COUNT(u.id)::int AS joined,
                COUNT(u.id) FILTER (WHERE u.referral_rewarded)::int AS rewarded
         FROM users u JOIN users r ON r.id = u.referred_by
         GROUP BY r.id ORDER BY joined DESC LIMIT 10`
      ),
      planDiscounts(),
    ]);

    res.json({
      campaigns: campaigns.map((c) => ({
        ...campaignView(c),
        active: c.active,
        startsAt: toIso(c.starts_at),
      })),
      codes: codes.map((p) => ({
        id: p.id,
        code: p.code,
        kind: p.kind,
        value: Number(p.value),
        maxUses: p.max_uses,
        usedCount: p.used_count,
        startsAt: toIso(p.starts_at),
        endsAt: toIso(p.ends_at),
        active: p.active,
      })),
      referral: { ...ref, ...refStats, topReferrers },
      planDiscounts: plans,
    });
  } catch (error) {
    next(error);
  }
});

promoAdminRouter.post("/campaigns", async (req, res, next) => {
  try {
    const name = String(req.body.name || "").trim().slice(0, 80);
    const banner = String(req.body.banner || "").trim().slice(0, 160);
    const percent = Number(req.body.discountPercent);
    const startsAt = dateOrNull(req.body.startsAt);
    const endsAt = dateOrNull(req.body.endsAt);

    if (!name) throw httpError(400, "Give the campaign a name.");
    if (!(percent > 0 && percent <= 100)) throw httpError(400, "Discount must be between 1 and 100%.");
    if (startsAt && endsAt && endsAt <= startsAt) throw httpError(400, "The end must be after the start.");

    await one(
      "INSERT INTO campaigns (name, banner, discount_percent, starts_at, ends_at) VALUES ($1, $2, $3, $4, $5)",
      [name, banner || null, percent, startsAt, endsAt]
    );
    res.status(201).json({ ok: true });
  } catch (error) {
    next(error);
  }
});

promoAdminRouter.post("/campaigns/:id/toggle", async (req, res, next) => {
  try {
    await one("UPDATE campaigns SET active = NOT active WHERE id = $1", [Number(req.params.id)]);
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

promoAdminRouter.delete("/campaigns/:id", async (req, res, next) => {
  try {
    await one("UPDATE payments SET campaign_id = NULL WHERE campaign_id = $1", [Number(req.params.id)]);
    await one("DELETE FROM campaigns WHERE id = $1", [Number(req.params.id)]);
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

promoAdminRouter.post("/codes", async (req, res, next) => {
  try {
    const code = String(req.body.code || "").trim().toUpperCase();
    const kind = req.body.kind === "fixed" ? "fixed" : "percent";
    const value = Number(req.body.value);
    const maxUses = req.body.maxUses === "" || req.body.maxUses == null ? null : Number(req.body.maxUses);
    const startsAt = dateOrNull(req.body.startsAt);
    const endsAt = dateOrNull(req.body.endsAt);

    if (!/^[A-Z0-9_-]{3,30}$/.test(code)) throw httpError(400, "Codes use 3–30 letters, numbers, - or _.");
    if (!(value > 0) || (kind === "percent" && value > 100)) throw httpError(400, "Enter a valid discount.");
    if (maxUses !== null && !(Number.isInteger(maxUses) && maxUses > 0)) throw httpError(400, "Max uses must be a whole number.");
    if (startsAt && endsAt && endsAt <= startsAt) throw httpError(400, "The end must be after the start.");

    await one(
      `INSERT INTO promo_codes (code, kind, value, max_uses, starts_at, ends_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [code, kind, value, maxUses, startsAt, endsAt]
    ).catch((error) => {
      if (error.code === "23505") throw httpError(409, "That code already exists.");
      throw error;
    });

    res.status(201).json({ ok: true });
  } catch (error) {
    next(error);
  }
});

promoAdminRouter.post("/codes/:id/toggle", async (req, res, next) => {
  try {
    await one("UPDATE promo_codes SET active = NOT active WHERE id = $1", [Number(req.params.id)]);
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

promoAdminRouter.delete("/codes/:id", async (req, res, next) => {
  try {
    await one("UPDATE payments SET promo_code_id = NULL WHERE promo_code_id = $1", [Number(req.params.id)]);
    await one("DELETE FROM promo_codes WHERE id = $1", [Number(req.params.id)]);
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

promoAdminRouter.put("/plans", async (req, res, next) => {
  try {
    const pct = (v) => Math.min(90, Math.max(0, Math.round(Number(v) || 0)));

    await saveSettings({
      planDiscount3: pct(req.body[3]),
      planDiscount6: pct(req.body[6]),
      planDiscount12: pct(req.body[12]),
    });

    res.json(await planDiscounts());
  } catch (error) {
    next(error);
  }
});

promoAdminRouter.put("/referral", async (req, res, next) => {
  try {
    const n = (v, max) => Math.min(max, Math.max(0, Math.round(Number(v) || 0)));

    await saveSettings({
      referralEnabled: req.body.enabled ? "true" : "false",
      referralFriendsPerReward: Math.max(1, n(req.body.friendsPerReward, 100)),
      referralRewardPercent: n(req.body.rewardPercent, 90),
    });

    res.json(await referralSettings());
  } catch (error) {
    next(error);
  }
});

