// Database access. Production (Vercel) uses Postgres via DATABASE_URL
// (e.g. Neon). Local development without DATABASE_URL uses PGlite, an
// embedded Postgres stored in data/pglite, so no setup is needed.
import { mkdirSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const DATA_DIR = path.join(__dirname, "..", "data");

const DATABASE_URL = process.env.DATABASE_URL || process.env.POSTGRES_URL || "";

export const usingLocalDatabase = !DATABASE_URL;

if (usingLocalDatabase && process.env.VERCEL) {
  throw new Error(
    "DATABASE_URL is not set. Add a Postgres database (e.g. Neon) to the Vercel project."
  );
}

// ---------- Driver adapters (same shape for both) ----------

async function createDriver() {
  if (!usingLocalDatabase) {
    const { default: pg } = await import("pg");
    const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 5 });

    return {
      query: (sql, params) => pool.query(sql, params),
      exec: (sql) => pool.query(sql),
      async transaction(fn) {
        const client = await pool.connect();

        try {
          await client.query("BEGIN");
          const result = await fn((sql, params) => client.query(sql, params));
          await client.query("COMMIT");
          return result;
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        } finally {
          client.release();
        }
      },
    };
  }

  const { PGlite } = await import("@electric-sql/pglite");
  const dir = path.join(DATA_DIR, "pglite");

  mkdirSync(dir, { recursive: true });

  const lite = new PGlite(dir);

  return {
    query: (sql, params) => lite.query(sql, params),
    exec: (sql) => lite.exec(sql),
    transaction: (fn) => lite.transaction((tx) => fn((sql, params) => tx.query(sql, params))),
  };
}

// ---------- Schema ----------

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'user',
    free_uses INTEGER NOT NULL DEFAULT 0,
    pro_until TIMESTAMPTZ,
    pay_ref TEXT NOT NULL UNIQUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TIMESTAMPTZ NOT NULL
  );

  CREATE TABLE IF NOT EXISTS visitors (
    id TEXT PRIMARY KEY,
    free_uses INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  CREATE TABLE IF NOT EXISTS ip_usage (
    ip_hash TEXT PRIMARY KEY,
    free_uses INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS payments (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    amount DOUBLE PRECISION NOT NULL,
    currency TEXT NOT NULL,
    months INTEGER NOT NULL DEFAULT 1,
    method TEXT NOT NULL DEFAULT 'bank_transfer',
    transaction_ref TEXT,
    paid_on TEXT,
    note TEXT,
    receipt_file TEXT,
    receipt_type TEXT,
    order_id TEXT UNIQUE,
    gateway_payment_id TEXT,
    gateway_method TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    admin_note TEXT,
    reviewed_by INTEGER REFERENCES users(id),
    reviewed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  CREATE INDEX IF NOT EXISTS payments_status ON payments(status);
  CREATE INDEX IF NOT EXISTS payments_user ON payments(user_id);

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  -- Login rate limiting has to live in the database: on Vercel every
  -- request can be served by a different instance.
  -- Offers: timed sale campaigns and promo codes.
  CREATE TABLE IF NOT EXISTS campaigns (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    banner TEXT,
    discount_percent DOUBLE PRECISION NOT NULL,
    starts_at TIMESTAMPTZ,
    ends_at TIMESTAMPTZ,
    active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  CREATE TABLE IF NOT EXISTS promo_codes (
    id SERIAL PRIMARY KEY,
    code TEXT NOT NULL UNIQUE,
    kind TEXT NOT NULL DEFAULT 'percent',
    value DOUBLE PRECISION NOT NULL,
    max_uses INTEGER,
    used_count INTEGER NOT NULL DEFAULT 0,
    starts_at TIMESTAMPTZ,
    ends_at TIMESTAMPTZ,
    active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  -- Columns added after the first release (safe to re-run).
  ALTER TABLE users ADD COLUMN IF NOT EXISTS referral_code TEXT UNIQUE;
  ALTER TABLE users ADD COLUMN IF NOT EXISTS referred_by INTEGER REFERENCES users(id) ON DELETE SET NULL;
  ALTER TABLE users ADD COLUMN IF NOT EXISTS referral_rewarded BOOLEAN NOT NULL DEFAULT false;
  ALTER TABLE users ADD COLUMN IF NOT EXISTS referral_days_earned INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE users ADD COLUMN IF NOT EXISTS bonus_uses INTEGER NOT NULL DEFAULT 0;
  -- Referral rewards (% off a payment) already used.
  ALTER TABLE users ADD COLUMN IF NOT EXISTS referral_rewards_used INTEGER NOT NULL DEFAULT 0;
  -- Which Pro period (pro_until) the last expiry reminder email was for.
  ALTER TABLE users ADD COLUMN IF NOT EXISTS expiry_reminder_for TIMESTAMPTZ;
  ALTER TABLE users ADD COLUMN IF NOT EXISTS expiry_reminder_stage TEXT;

  ALTER TABLE payments ADD COLUMN IF NOT EXISTS list_amount DOUBLE PRECISION;
  ALTER TABLE payments ADD COLUMN IF NOT EXISTS discount_amount DOUBLE PRECISION NOT NULL DEFAULT 0;
  ALTER TABLE payments ADD COLUMN IF NOT EXISTS expected_amount DOUBLE PRECISION;
  ALTER TABLE payments ADD COLUMN IF NOT EXISTS discount_label TEXT;
  ALTER TABLE payments ADD COLUMN IF NOT EXISTS reward_applied BOOLEAN NOT NULL DEFAULT false;
  ALTER TABLE payments ADD COLUMN IF NOT EXISTS promo_code_id INTEGER REFERENCES promo_codes(id) ON DELETE SET NULL;
  ALTER TABLE payments ADD COLUMN IF NOT EXISTS campaign_id INTEGER REFERENCES campaigns(id) ON DELETE SET NULL;

  -- 6-digit codes emailed for signup verification and password reset.
  -- Only a hash of the code is stored.
  CREATE TABLE IF NOT EXISTS email_codes (
    id SERIAL PRIMARY KEY,
    email TEXT NOT NULL,
    purpose TEXT NOT NULL,
    code_hash TEXT NOT NULL,
    payload TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  CREATE INDEX IF NOT EXISTS email_codes_lookup ON email_codes(email, purpose);

  -- Google accounts linked to a user.
  CREATE TABLE IF NOT EXISTS oauth_accounts (
    provider TEXT NOT NULL,
    provider_user_id TEXT NOT NULL,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (provider, provider_user_id)
  );

  CREATE TABLE IF NOT EXISTS rate_limits (
    key TEXT PRIMARY KEY,
    count INTEGER NOT NULL,
    reset_at TIMESTAMPTZ NOT NULL
  );
`;

// Connect and create tables once per process (once per cold start on Vercel).
let ready;

function driver() {
  ready ||= createDriver()
    .then(async (d) => {
      await d.exec(SCHEMA);
      return d;
    })
    .catch((error) => {
      // Don't keep a failed connection forever: try again on the next request.
      ready = null;
      throw error;
    });

  return ready;
}

/** Runs a query and returns all rows. Uses $1, $2... placeholders. */
export async function query(sql, params = []) {
  const d = await driver();
  const result = await d.query(sql, params);

  return result.rows;
}

/** Runs a query and returns the first row (or undefined). */
export async function one(sql, params = []) {
  return (await query(sql, params))[0];
}

/** Runs fn(q) inside a transaction; q(sql, params) returns rows. */
export async function transaction(fn) {
  const d = await driver();

  return d.transaction((run) =>
    fn(async (sql, params = []) => (await run(sql, params)).rows)
  );
}

// ---------- Settings ----------

const DEFAULT_SETTINGS = {
  price: process.env.PRO_PRICE || "4.99",
  currency: process.env.PRO_CURRENCY || "USD",
  bankName: "",
  accountName: "",
  accountNumber: "",
  branch: "",
  instructions: "",
  // Referral programme (admin → Promotions): every N friends who join
  // give the referrer X% off their next payment.
  referralEnabled: "true",
  referralFriendsPerReward: "5",
  referralRewardPercent: "5",
  // % off for longer plans (admin → Promotions)
  planDiscount3: "0",
  planDiscount6: "0",
  planDiscount12: "0",
};

// Pass q when called inside transaction(): the local database (PGlite) runs
// one query at a time, so a query outside the transaction would wait forever.
export async function getSettings(q) {
  const sql = "SELECT key, value FROM settings";
  const rows = q ? await q(sql) : await query(sql);
  const stored = Object.fromEntries(rows.map((r) => [r.key, r.value]));

  return {
    ...DEFAULT_SETTINGS,
    ...stored,
    price: Number(stored.price ?? DEFAULT_SETTINGS.price),
  };
}

export async function saveSettings(values) {
  await transaction(async (q) => {
    for (const key of Object.keys(DEFAULT_SETTINGS)) {
      if (values[key] !== undefined) {
        await q(
          "INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
          [key, String(values[key])]
        );
      }
    }
  });

  return getSettings();
}

export function toIso(value) {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}
