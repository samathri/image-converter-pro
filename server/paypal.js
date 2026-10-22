// PayPal Checkout (Orders v2 API, redirect flow).
// 1. /checkout creates an order and sends the buyer to PayPal.
// 2. PayPal returns the buyer to /?payment=paypal&token=ORDER_ID.
// 3. /capture captures the payment server-side; Pro is granted only when the
//    capture is COMPLETED and the amount and currency match the order.
// No webhook is needed, so this works on any domain (and on localhost).
import express from "express";
import { getSettings, one, transaction } from "./db.js";
import { requireUser } from "./auth.js";
import { extendPro, PLAN_MONTHS } from "./plans.js";

const CLIENT_ID = process.env.PAYPAL_CLIENT_ID || "";
const CLIENT_SECRET = process.env.PAYPAL_CLIENT_SECRET || "";
const SANDBOX = process.env.PAYPAL_SANDBOX !== "false";
// PAYPAL_API_BASE is only for automated tests against a fake PayPal server.
const API =
  process.env.PAYPAL_API_BASE ||
  (SANDBOX ? "https://api-m.sandbox.paypal.com" : "https://api-m.paypal.com");

// Currencies PayPal accepts with two decimal places (LKR is not supported).
const SUPPORTED_CURRENCIES = [
  "USD", "EUR", "GBP", "AUD", "CAD", "SGD", "NZD", "CHF",
  "SEK", "NOK", "DKK", "PLN", "HKD", "CZK", "MXN", "ILS", "PHP",
];

const httpError = (status, message) => Object.assign(new Error(message), { status });

function formatAmount(amount) {
  return (Math.round(Number(amount) * 100) / 100).toFixed(2);
}

function publicUrl(req) {
  const fromEnv =
    process.env.PUBLIC_URL ||
    (process.env.VERCEL_PROJECT_PRODUCTION_URL && `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`);

  return (fromEnv || `${req.protocol}://${req.get("host")}`).replace(/\/+$/, "");
}

export async function paypalStatus() {
  const { currency } = await getSettings();
  const configured = Boolean(CLIENT_ID && CLIENT_SECRET);
  const currencySupported = SUPPORTED_CURRENCIES.includes(currency);

  return { configured, sandbox: SANDBOX, currencySupported, enabled: configured && currencySupported };
}

// ---------- PayPal REST helpers ----------

let cachedToken = null;

async function accessToken() {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) return cachedToken.value;

  const response = await fetch(`${API}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });

  if (!response.ok) {
    console.error("[paypal] could not get an access token:", response.status, await response.text());
    throw httpError(502, "PayPal is not available right now. Please try again or use bank transfer.");
  }

  const data = await response.json();

  cachedToken = { value: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
  return cachedToken.value;
}

async function paypal(path, { method = "GET", body, requestId } = {}) {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${await accessToken()}`,
      "Content-Type": "application/json",
      ...(requestId && { "PayPal-Request-Id": requestId }),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = await response.json().catch(() => ({}));

  return { ok: response.ok, status: response.status, data };
}

// ---------- Routes ----------

export const paypalRouter = express.Router();

paypalRouter.use(requireUser);

// Creates a PayPal order and returns the URL to send the buyer to.
paypalRouter.post("/checkout", async (req, res, next) => {
  try {
    const status = await paypalStatus();

    if (!status.enabled) {
      throw httpError(503, "PayPal isn't available right now. Please use bank transfer.");
    }

    const months = Number(req.body.months);

    if (!PLAN_MONTHS.includes(months)) throw httpError(400, "Choose a valid plan length.");

    const bankPending = await one("SELECT id FROM payments WHERE user_id = $1 AND status = 'pending'", [req.user.id]);

    if (bankPending) {
      throw httpError(409, "You already have a bank payment under review. Please wait for it to be checked.");
    }

    const settings = await getSettings();
    const amount = Math.round(settings.price * months * 100) / 100;

    const payment = await one(
      `INSERT INTO payments (user_id, amount, currency, months, method, status)
       VALUES ($1, $2, $3, $4, 'paypal', 'awaiting_payment') RETURNING id`,
      [req.user.id, amount, settings.currency, months]
    );

    const base = publicUrl(req);
    const order = await paypal("/v2/checkout/orders", {
      method: "POST",
      requestId: `icp-order-${payment.id}`,
      body: {
        intent: "CAPTURE",
        purchase_units: [
          {
            reference_id: String(payment.id),
            custom_id: String(payment.id),
            description: `Image Converter Pro: ${months} month${months === 1 ? "" : "s"}`,
            amount: { currency_code: settings.currency, value: formatAmount(amount) },
          },
        ],
        payment_source: {
          paypal: {
            experience_context: {
              brand_name: "Image Converter Pro",
              user_action: "PAY_NOW",
              shipping_preference: "NO_SHIPPING",
              return_url: `${base}/?payment=paypal`,
              cancel_url: `${base}/?payment=paypal-cancel`,
            },
          },
        },
      },
    });

    const approveLink = order.data.links?.find((l) => l.rel === "payer-action" || l.rel === "approve");

    if (!order.ok || !order.data.id || !approveLink) {
      console.error("[paypal] create order failed:", order.status, JSON.stringify(order.data));
      await one("UPDATE payments SET status = 'failed' WHERE id = $1", [payment.id]);
      throw httpError(502, "Could not start the PayPal payment. Please try again.");
    }

    await one("UPDATE payments SET order_id = $1 WHERE id = $2", [order.data.id, payment.id]);

    res.json({ url: approveLink.href });
  } catch (error) {
    next(error);
  }
});

// Called by the app when PayPal sends the buyer back.
paypalRouter.post("/capture", async (req, res, next) => {
  try {
    const orderId = String(req.body.orderId || "");
    const payment = await one(
      "SELECT * FROM payments WHERE order_id = $1 AND method = 'paypal' AND user_id = $2",
      [orderId, req.user.id]
    );

    if (!payment) throw httpError(404, "Payment not found.");
    if (payment.status === "approved") return res.json({ status: "approved" });
    if (payment.status !== "awaiting_payment") throw httpError(409, `This payment was ${payment.status}.`);

    // Capturing twice with the same request id is safe (PayPal returns the first result).
    let result = await paypal(`/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, {
      method: "POST",
      requestId: `icp-capture-${payment.id}`,
    });

    // If it was already captured some other way, read the order instead.
    if (!result.ok) {
      const order = await paypal(`/v2/checkout/orders/${encodeURIComponent(orderId)}`);

      if (order.ok && order.data.status === "COMPLETED") {
        result = order;
      } else {
        console.warn("[paypal] capture failed:", result.status, JSON.stringify(result.data));
        throw httpError(402, "PayPal didn't complete the payment. You can try again.");
      }
    }

    const unit = result.data.purchase_units?.[0];
    const capture = unit?.payments?.captures?.[0];

    const valid =
      result.data.status === "COMPLETED" &&
      capture?.status === "COMPLETED" &&
      capture.amount?.value === formatAmount(payment.amount) &&
      capture.amount?.currency_code === payment.currency &&
      (capture.custom_id ?? unit?.custom_id ?? String(payment.id)) === String(payment.id);

    if (!valid) {
      console.warn("[paypal] capture not accepted:", JSON.stringify({ status: result.data.status, capture }));
      throw httpError(402, "The payment couldn't be confirmed. Please contact us if money was taken.");
    }

    const granted = await transaction(async (q) => {
      const [locked] = await q("SELECT status FROM payments WHERE id = $1 FOR UPDATE", [payment.id]);

      if (locked.status === "approved") return false; // another request finished first

      await q(
        `UPDATE payments SET status = 'approved', gateway_payment_id = $1, gateway_method = 'PAYPAL',
         transaction_ref = $1, paid_on = to_char(now(), 'YYYY-MM-DD'), reviewed_at = now(),
         admin_note = 'Paid with PayPal' WHERE id = $2`,
        [capture.id, payment.id]
      );
      await extendPro(payment.user_id, payment.months, q);
      return true;
    });

    res.json({ status: "approved", granted });
  } catch (error) {
    next(error);
  }
});

// Called when the buyer cancels on PayPal's page.
paypalRouter.post("/cancel", async (req, res, next) => {
  try {
    await one(
      `UPDATE payments SET status = 'cancelled'
       WHERE order_id = $1 AND method = 'paypal' AND user_id = $2 AND status = 'awaiting_payment'`,
      [String(req.body.orderId || ""), req.user.id]
    );
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});
