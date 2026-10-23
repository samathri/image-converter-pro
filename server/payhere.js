import crypto from "crypto";
import express from "express";
import { getSettings, one, transaction } from "./db.js";
import { rejectAdminPayments, requireUser } from "./auth.js";
import { extendPro, PLAN_MONTHS } from "./plans.js";
import { onPaymentApproved, quote } from "./promotions.js";

// Docs: https://support.payhere.lk/api-&-mobile-sdk/checkout-api
const MERCHANT_ID = process.env.PAYHERE_MERCHANT_ID || "";
const MERCHANT_SECRET = process.env.PAYHERE_MERCHANT_SECRET || "";
const SANDBOX = process.env.PAYHERE_SANDBOX !== "false";
const CHECKOUT_URL = SANDBOX
  ? "https://sandbox.payhere.lk/pay/checkout"
  : "https://www.payhere.lk/pay/checkout";

// The checkout API only accepts these currencies.
const SUPPORTED_CURRENCIES = ["LKR", "USD"];

const STATUS = {
  SUCCESS: "2",
  PENDING: "0",
  CANCELLED: "-1",
  FAILED: "-2",
  CHARGEDBACK: "-3",
};

function md5Upper(value) {
  return crypto.createHash("md5").update(value).digest("hex").toUpperCase();
}

function formatAmount(amount) {
  return (Math.round(Number(amount) * 100) / 100).toFixed(2);
}

function checkoutHash(orderId, amount, currency) {
  return md5Upper(MERCHANT_ID + orderId + formatAmount(amount) + currency + md5Upper(MERCHANT_SECRET));
}

function notifySignature({ order_id, payhere_amount, payhere_currency, status_code }) {
  return md5Upper(
    MERCHANT_ID + order_id + payhere_amount + payhere_currency + status_code + md5Upper(MERCHANT_SECRET)
  );
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));

  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

// The public base URL PayHere can reach (notify_url must not be localhost).
// On Vercel the production domain is used automatically.
function publicUrl(req) {
  const fromEnv =
    process.env.PUBLIC_URL ||
    (process.env.VERCEL_PROJECT_PRODUCTION_URL && `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`);

  return (fromEnv || `${req.protocol}://${req.get("host")}`).replace(/\/+$/, "");
}

export async function payhereStatus(req) {
  const { currency } = await getSettings();
  const configured = Boolean(MERCHANT_ID && MERCHANT_SECRET);
  const base = req ? publicUrl(req) : process.env.PUBLIC_URL || "";
  const looksLocal = /localhost|127\.0\.0\.1|\[::1\]/.test(base);

  return {
    configured,
    sandbox: SANDBOX,
    currencySupported: SUPPORTED_CURRENCIES.includes(currency),
    // Live payments need a reachable notify_url, or users would pay
    // and never get Pro. Sandbox stays usable for testing.
    enabled: configured && SUPPORTED_CURRENCIES.includes(currency) && (SANDBOX || !looksLocal),
    notifyUrl: base ? `${base}/api/payhere/notify` : null,
    publicUrlLooksLocal: looksLocal,
  };
}

// ---------- Start a checkout (logged-in user) ----------

export const payhereRouter = express.Router();

payhereRouter.post("/checkout", requireUser, rejectAdminPayments, async (req, res, next) => {
  try {
    const status = await payhereStatus(req);

    if (!status.enabled) {
      return res.status(503).json({
        message: "Card payments aren't available right now. Please use bank transfer.",
      });
    }

    const months = Number(req.body.months);
    const phone = String(req.body.phone || "").trim();
    const address = String(req.body.address || "").trim();
    const city = String(req.body.city || "").trim();
    const country = String(req.body.country || "Sri Lanka").trim();

    if (!PLAN_MONTHS.includes(months)) {
      return res.status(400).json({ message: "Choose a valid plan length." });
    }

    if (!/^\+?[\d\s-]{9,16}$/.test(phone)) {
      return res.status(400).json({ message: "Enter a valid phone number." });
    }

    if (!address || address.length > 200 || !city || city.length > 80) {
      return res.status(400).json({ message: "Enter your address and city." });
    }

    const bankPending = await one("SELECT id FROM payments WHERE user_id = $1 AND status = 'pending'", [req.user.id]);

    if (bankPending) {
      return res.status(409).json({
        message: "You already have a bank payment under review. Please wait for it to be checked.",
      });
    }

    const settings = await getSettings();
    const price = await quote(req.user, months, req.body.promoCode);
    const amount = price.total;

    if (amount <= 0) {
      return res.status(400).json({ message: "This plan is free with your code. Use “Activate Pro” instead." });
    }
    const orderId = `ICP-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;

    await one(
      `INSERT INTO payments (user_id, amount, currency, months, method, order_id, status,
         list_amount, discount_amount, expected_amount, promo_code_id, campaign_id, discount_label)
       VALUES ($1, $2, $3, $4, 'payhere', $5, 'awaiting_payment', $6, $7, $2, $8, $9, $10)`,
      [req.user.id, amount, settings.currency, months, orderId, price.listAmount, price.discount, price.promoCodeId, price.campaignId, price.discountLabel]
    );

    const [firstName, ...rest] = req.user.name.trim().split(/\s+/);
    const base = publicUrl(req);

    res.json({
      action: CHECKOUT_URL,
      fields: {
        merchant_id: MERCHANT_ID,
        return_url: `${base}/?payment=return`,
        cancel_url: `${base}/?payment=cancelled`,
        notify_url: `${base}/api/payhere/notify`,
        order_id: orderId,
        items: `Image Converter Pro: ${months} month${months === 1 ? "" : "s"}`,
        currency: settings.currency,
        amount: formatAmount(amount),
        first_name: firstName,
        last_name: rest.join(" ") || firstName,
        email: req.user.email,
        phone,
        address,
        city,
        country,
        custom_1: String(req.user.id),
        hash: checkoutHash(orderId, amount, settings.currency),
      },
    });
  } catch (error) {
    next(error);
  }
});

// ---------- Payment notification (PayHere server → our server) ----------

export const payhereNotifyRouter = express.Router();

payhereNotifyRouter.post(
  "/notify",
  express.urlencoded({ extended: false, limit: "10kb" }),
  async (req, res) => {
    const body = req.body || {};

    // Always answer 200 so PayHere doesn't retry forever; problems are logged.
    const done = (message) => {
      if (message) console.warn(`[payhere] ${message}`, body.order_id || "");
      res.status(200).send("OK");
    };

    if (!MERCHANT_ID || !MERCHANT_SECRET) return done("notify received but PayHere is not configured");
    if (body.merchant_id !== MERCHANT_ID) return done("merchant_id mismatch");

    if (!safeEqual(String(body.md5sig || "").toUpperCase(), notifySignature(body))) {
      return done("invalid md5sig");
    }

    try {
      await transaction(async (q) => {
        const [payment] = await q(
          "SELECT * FROM payments WHERE order_id = $1 AND method = 'payhere' FOR UPDATE",
          [String(body.order_id)]
        );

        if (!payment) throw new Error("unknown order_id");

        const statusCode = String(body.status_code);

        if (statusCode === STATUS.SUCCESS) {
          if (payment.status === "approved") return; // duplicate notification

          // Never trust the amount blindly: it must match what we asked for.
          if (body.payhere_amount !== formatAmount(payment.amount) || body.payhere_currency !== payment.currency) {
            throw new Error(
              `amount mismatch: got ${body.payhere_amount} ${body.payhere_currency}, expected ${formatAmount(payment.amount)} ${payment.currency}`
            );
          }

          await q(
            `UPDATE payments SET status = 'approved', gateway_payment_id = $1, gateway_method = $2,
             transaction_ref = $1, paid_on = to_char(now(), 'YYYY-MM-DD'), reviewed_at = now(),
             admin_note = 'Paid with PayHere' WHERE id = $3`,
            [String(body.payment_id || ""), String(body.method || ""), payment.id]
          );

          await onPaymentApproved(q, payment);
          await extendPro(payment.user_id, payment.months, q);
          return;
        }

        if (statusCode === STATUS.CHARGEDBACK && payment.status === "approved") {
          // Take back the months this payment granted.
          const [user] = await q("SELECT pro_until FROM users WHERE id = $1 FOR UPDATE", [payment.user_id]);

          if (user?.pro_until) {
            const until = new Date(user.pro_until);

            until.setMonth(until.getMonth() - payment.months);
            await q("UPDATE users SET pro_until = $1 WHERE id = $2", [
              until > new Date() ? until : null,
              payment.user_id,
            ]);
          }

          await q("UPDATE payments SET status = 'chargedback', reviewed_at = now() WHERE id = $1", [payment.id]);
          return;
        }

        if (
          (statusCode === STATUS.CANCELLED || statusCode === STATUS.FAILED) &&
          payment.status === "awaiting_payment"
        ) {
          await q("UPDATE payments SET status = $1, admin_note = $2 WHERE id = $3", [
            statusCode === STATUS.CANCELLED ? "cancelled" : "failed",
            String(body.status_message || "").slice(0, 200) || null,
            payment.id,
          ]);
        }
      });

      done();
    } catch (error) {
      done(error.message);
    }
  }
);
