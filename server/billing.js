import express from "express";
import { getSettings, one, query, saveSettings, toIso, transaction } from "./db.js";
import { isAdmin, rejectAdminPayments, requireAdmin, requireUser, getUserById, isPro, publicUser } from "./auth.js";
import { payhereStatus } from "./payhere.js";
import { paypalStatus } from "./paypal.js";
import { extendPro, PLAN_MONTHS } from "./plans.js";
import { deleteFiles, downloadUrl, readFile, usingBlob, localFilePath } from "./storage.js";

export const RECEIPT_MAX_BYTES = 5 * 1024 * 1024;
export const RECEIPT_TYPES = ["image/jpeg", "image/png", "image/webp", "application/pdf"];

// Identify receipts by their bytes, not the name the browser sent.
function detectReceiptType(buffer) {
  const hex = buffer.subarray(0, 12).toString("hex");
  const ascii = buffer.subarray(0, 12).toString("latin1");

  if (hex.startsWith("ffd8ff")) return "image/jpeg";
  if (hex.startsWith("89504e47")) return "image/png";
  if (ascii.startsWith("RIFF") && ascii.slice(8, 12) === "WEBP") return "image/webp";
  if (ascii.startsWith("%PDF")) return "application/pdf";

  return null;
}

function paymentView(row) {
  return {
    id: row.id,
    amount: Number(row.amount),
    currency: row.currency,
    months: row.months,
    method: row.method,
    transactionRef: row.transaction_ref,
    paidOn: row.paid_on,
    note: row.note,
    status: row.status,
    adminNote: row.admin_note,
    createdAt: toIso(row.created_at),
    reviewedAt: toIso(row.reviewed_at),
    receiptType: row.receipt_type,
    hasReceipt: Boolean(row.receipt_file),
    orderId: row.order_id,
    gatewayMethod: row.gateway_method,
    ...(row.email !== undefined && {
      user: {
        id: row.user_id,
        email: row.email,
        name: row.name,
        payRef: row.pay_ref,
        proUntil: isPro({ pro_until: row.pro_until }) ? toIso(row.pro_until) : null,
        isAdmin: row.user_role === "admin",
      },
    }),
  };
}

const httpError = (status, message) => Object.assign(new Error(message), { status });

// ---------- User billing ----------

export const billingRouter = express.Router();

billingRouter.use(requireUser);

billingRouter.get("/", async (req, res, next) => {
  try {
    const settings = await getSettings();
    const payments = await query(
      "SELECT * FROM payments WHERE user_id = $1 AND status != 'awaiting_payment' ORDER BY id DESC",
      [req.user.id]
    );
    const payhere = await payhereStatus(req);
    const paypal = await paypalStatus();

    res.json({
      price: settings.price,
      currency: settings.currency,
      planMonths: PLAN_MONTHS,
      methods: {
        paypal: paypal.enabled,
        paypalSandbox: paypal.sandbox,
        payhere: payhere.enabled,
        payhereSandbox: payhere.sandbox,
        bank: Boolean(settings.accountNumber),
      },
      bank: {
        bankName: settings.bankName,
        accountName: settings.accountName,
        accountNumber: settings.accountNumber,
        branch: settings.branch,
        instructions: settings.instructions,
      },
      payRef: req.user.pay_ref,
      payments: payments.map(paymentView),
    });
  } catch (error) {
    next(error);
  }
});

// The receipt itself is uploaded first (see uploads.js); this records the payment.
billingRouter.post("/payments", rejectAdminPayments, async (req, res, next) => {
  const receiptPath = String(req.body.receiptPath || "");
  const ownReceipt = receiptPath.startsWith(`receipts/${req.user.id}/`);

  try {
    const settings = await getSettings();
    const months = Number(req.body.months);
    const amount = Number(req.body.amount);
    const transactionRef = String(req.body.transactionRef || "").trim();
    const paidOn = String(req.body.paidOn || "");
    const note = String(req.body.note || "").trim().slice(0, 500);

    const pending = await one("SELECT id FROM payments WHERE user_id = $1 AND status = 'pending'", [req.user.id]);

    if (pending) throw httpError(409, "You already have a payment waiting for review.");
    if (!PLAN_MONTHS.includes(months)) throw httpError(400, "Choose a valid plan length.");
    if (!(amount > 0) || amount > 1e7) throw httpError(400, "Enter the amount you paid.");

    if (!transactionRef || transactionRef.length > 100) {
      throw httpError(400, "Enter the transaction ID or reference from your bank.");
    }

    const paidDate = new Date(paidOn);

    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(paidOn) ||
      Number.isNaN(paidDate.getTime()) ||
      paidDate.getTime() > Date.now() + 864e5
    ) {
      throw httpError(400, "Enter a valid payment date.");
    }

    // Receipts can only come from this user's own upload folder.
    if (!ownReceipt) throw httpError(400, "Attach a photo or PDF of your payment receipt.");

    const buffer = await readFile(receiptPath);

    if (!buffer) throw httpError(400, "The receipt upload was not found. Please attach it again.");
    if (buffer.length > RECEIPT_MAX_BYTES) throw httpError(400, "Receipt must be smaller than 5 MB.");

    const type = detectReceiptType(buffer);

    if (!type) throw httpError(400, "Receipt must be a JPG, PNG, WEBP or PDF file.");

    const row = await one(
      `INSERT INTO payments
        (user_id, amount, currency, months, transaction_ref, paid_on, note, receipt_file, receipt_type)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [req.user.id, amount, settings.currency, months, transactionRef, paidOn, note || null, receiptPath, type]
    );

    res.status(201).json({ payment: paymentView(row) });
  } catch (error) {
    // Don't keep receipts for payments that weren't recorded.
    if (ownReceipt) await deleteFiles([receiptPath]).catch(() => {});
    next(error);
  }
});

// ---------- Admin ----------

export const adminRouter = express.Router();

adminRouter.use(requireAdmin);

adminRouter.get("/stats", async (req, res, next) => {
  try {
    const monthStart = new Date();

    monthStart.setDate(1);
    monthStart.setHours(0, 0, 0, 0);

    const count = async (sql, params) => (await one(sql, params)).n;

    res.json({
      pending: await count("SELECT COUNT(*)::int n FROM payments WHERE status = 'pending'"),
      activePro: await count("SELECT COUNT(*)::int n FROM users WHERE pro_until > now() AND role = 'user'"),
      users: await count("SELECT COUNT(*)::int n FROM users WHERE role = 'user'"),
      revenueThisMonth: (
        await query(
          `SELECT currency, SUM(amount)::float8 total FROM payments
           WHERE status = 'approved' AND reviewed_at >= $1
           GROUP BY currency`,
          [monthStart]
        )
      ).map((r) => ({ currency: r.currency, total: Number(r.total) })),
      freeConversions: await count("SELECT COALESCE(SUM(free_uses), 0)::int n FROM visitors"),
    });
  } catch (error) {
    next(error);
  }
});

adminRouter.get("/payments", async (req, res, next) => {
  try {
    const status = String(req.query.status || "pending");
    const filtered = ["pending", "approved", "rejected"].includes(status);

    const rows = await query(
      `SELECT p.*, u.email, u.name, u.pro_until, u.pay_ref, u.role AS user_role FROM payments p
       JOIN users u ON u.id = p.user_id
       WHERE ${filtered ? "p.status = $1" : "p.status != 'awaiting_payment'"}
       ORDER BY (p.status = 'pending') DESC, p.id DESC
       LIMIT 200`,
      filtered ? [status] : []
    );

    res.json({ payments: rows.map(paymentView) });
  } catch (error) {
    next(error);
  }
});

adminRouter.get("/payments/:id/receipt", async (req, res, next) => {
  try {
    const row = await one("SELECT receipt_file, receipt_type FROM payments WHERE id = $1", [Number(req.params.id)]);

    if (!row?.receipt_file) {
      return res.status(404).json({ message: "Receipt not found." });
    }

    res.setHeader("Cache-Control", "private, no-store");

    // Vercel Blob: send the browser to a short-lived signed link.
    if (usingBlob) {
      return res.redirect(302, await downloadUrl(row.receipt_file, 10));
    }

    res.setHeader("Content-Type", row.receipt_type);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Security-Policy", "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'");
    res.sendFile(localFilePath(row.receipt_file));
  } catch (error) {
    next(error);
  }
});

async function reviewablePayment(q, id) {
  const [payment] = await q("SELECT * FROM payments WHERE id = $1 FOR UPDATE", [id]);

  if (!payment) throw httpError(404, "Payment not found.");
  if (payment.status !== "pending") throw httpError(409, `This payment was already ${payment.status}.`);

  return payment;
}

adminRouter.post("/payments/:id/approve", async (req, res, next) => {
  try {
    const result = await transaction(async (q) => {
      const payment = await reviewablePayment(q, Number(req.params.id));
      const months = PLAN_MONTHS.includes(Number(req.body.months)) ? Number(req.body.months) : payment.months;

      await q(
        `UPDATE payments SET status = 'approved', months = $1, admin_note = $2,
         reviewed_by = $3, reviewed_at = now() WHERE id = $4`,
        [months, String(req.body.note || "").trim().slice(0, 500) || null, req.user.id, payment.id]
      );

      return { proUntil: await extendPro(payment.user_id, months, q) };
    });

    res.json(result);
  } catch (error) {
    next(error);
  }
});

adminRouter.post("/payments/:id/reject", async (req, res, next) => {
  try {
    const note = String(req.body.note || "").trim().slice(0, 500);

    if (!note) throw httpError(400, "Add a reason so the user knows what to fix.");

    await transaction(async (q) => {
      const payment = await reviewablePayment(q, Number(req.params.id));

      await q(
        "UPDATE payments SET status = 'rejected', admin_note = $1, reviewed_by = $2, reviewed_at = now() WHERE id = $3",
        [note, req.user.id, payment.id]
      );
    });

    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

adminRouter.get("/users", async (req, res, next) => {
  try {
    const q = `%${String(req.query.q || "").trim()}%`;
    const rows = await query(
      `SELECT u.*,
        (SELECT COUNT(*)::int FROM payments p WHERE p.user_id = u.id AND p.status = 'approved') paid_count
       FROM users u
       WHERE u.email ILIKE $1 OR u.name ILIKE $1 OR u.pay_ref ILIKE $1
       ORDER BY u.id DESC LIMIT 200`,
      [q]
    );

    res.json({
      users: rows.map((u) => ({
        ...publicUser(u),
        freeUses: u.free_uses,
        createdAt: toIso(u.created_at),
        paidCount: u.paid_count,
        isOwner: isOwnerAccount(u),
        isYou: u.id === req.user.id,
      })),
    });
  } catch (error) {
    next(error);
  }
});

adminRouter.post("/users/:id/grant", async (req, res, next) => {
  try {
    const user = await getUserById(Number(req.params.id));
    const months = Number(req.body.months);

    if (!user) throw httpError(404, "User not found.");
    if (isAdmin(user)) throw httpError(400, "Admins already have unlimited access.");
    if (!PLAN_MONTHS.includes(months)) throw httpError(400, "Choose a valid number of months.");

    res.json({ proUntil: await transaction((q) => extendPro(user.id, months, q)) });
  } catch (error) {
    next(error);
  }
});

adminRouter.post("/users/:id/revoke", async (req, res, next) => {
  try {
    const row = await one("UPDATE users SET pro_until = NULL WHERE id = $1 RETURNING id", [Number(req.params.id)]);

    if (!row) throw httpError(404, "User not found.");
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

// The account in ADMIN_EMAIL is the site owner: it can't be demoted or deleted
// (it would be re-created as admin on the next start anyway).
function isOwnerAccount(user) {
  const owner = String(process.env.ADMIN_EMAIL || "").trim().toLowerCase();

  return Boolean(owner) && user.email === owner;
}

// Loads a user that the signed-in admin is allowed to change.
async function manageableUser(req, action) {
  const user = await getUserById(Number(req.params.id));

  if (!user) throw httpError(404, "User not found.");
  if (user.id === req.user.id) throw httpError(400, `You can't ${action} your own account.`);
  if (isOwnerAccount(user)) throw httpError(400, `The owner account (ADMIN_EMAIL) can't be ${action === "delete" ? "deleted" : "changed"}.`);

  return user;
}

adminRouter.post("/users/:id/role", async (req, res, next) => {
  try {
    const role = String(req.body.role);

    if (!["admin", "user"].includes(role)) throw httpError(400, "Role must be admin or user.");

    const user = await manageableUser(req, "change the role of");

    await one("UPDATE users SET role = $1 WHERE id = $2", [role, user.id]);
    res.json({ ok: true, role });
  } catch (error) {
    next(error);
  }
});

adminRouter.delete("/users/:id", async (req, res, next) => {
  try {
    const user = await manageableUser(req, "delete");
    const receipts = await query(
      "SELECT receipt_file FROM payments WHERE user_id = $1 AND receipt_file IS NOT NULL",
      [user.id]
    );

    await transaction(async (q) => {
      // Keep other users' payment history intact if this was a reviewer.
      await q("UPDATE payments SET reviewed_by = NULL WHERE reviewed_by = $1", [user.id]);
      // Payments and sessions are removed with the user (ON DELETE CASCADE).
      await q("DELETE FROM users WHERE id = $1", [user.id]);
    });

    await deleteFiles(receipts.map((r) => r.receipt_file)).catch(() => {});
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

adminRouter.get("/settings", async (req, res, next) => {
  try {
    res.json({ ...(await getSettings()), payhere: await payhereStatus(req), paypal: await paypalStatus() });
  } catch (error) {
    next(error);
  }
});

adminRouter.put("/settings", async (req, res, next) => {
  try {
    const price = Number(req.body.price);
    const currency = String(req.body.currency || "").trim().toUpperCase();

    if (!(price > 0)) throw httpError(400, "Price must be greater than 0.");

    try {
      new Intl.NumberFormat("en", { style: "currency", currency });
    } catch {
      throw httpError(400, "Use a 3-letter currency code like USD or LKR.");
    }

    const text = (key, max = 200) => String(req.body[key] ?? "").trim().slice(0, max);

    const saved = await saveSettings({
      price,
      currency,
      bankName: text("bankName"),
      accountName: text("accountName"),
      accountNumber: text("accountNumber"),
      branch: text("branch"),
      instructions: text("instructions", 1000),
    });

    res.json({ ...saved, payhere: await payhereStatus(req), paypal: await paypalStatus() });
  } catch (error) {
    next(error);
  }
});
