import { useCallback, useEffect, useState } from "react";
import { Icon } from "../icons.jsx";
import { fetchJson, formatDate, formatMoney } from "../api.js";
import Modal from "../Modal.jsx";
import "../Modal.css";
import "../Account.css";
import "./Admin.css";

const PLAN_MONTHS = [1, 3, 6, 12];
// Online gateways confirm payments themselves; bank transfers need review.
const GATEWAYS = { payhere: "PayHere", paypal: "PayPal" };
const SHORT_DATE = { day: "numeric", month: "short", year: "numeric" };

function useTheme() {
  useEffect(() => {
    try {
      document.documentElement.dataset.theme =
        localStorage.getItem("icp-theme") || "dark";
    } catch {
      document.documentElement.dataset.theme = "dark";
    }
  }, []);
}

// ---------- Login gate ----------

function AdminLogin({ onLoggedIn, notAdmin }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError("");

    try {
      await fetchJson("/api/auth/login", {
        method: "POST",
        json: { email, password },
      });
      await onLoggedIn();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="admin-gate">
      <form className="admin-gate-card form" onSubmit={submit}>
        <span className="admin-gate-icon">{Icon.shield}</span>
        <span className="eyebrow">Lab console</span>
        <h1>Admin sign in</h1>

        {notAdmin && (
          <p className="form-error">
            This account doesn&apos;t have admin access. Sign in with an
            admin account.
          </p>
        )}

        <label className="form-field">
          <span>Email</span>
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" required />
        </label>

        <label className="form-field">
          <span>Password</span>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
        </label>

        {error && <p className="form-error">{error}</p>}

        <button className="btn-primary" disabled={busy}>
          {busy ? "Signing in…" : <>Sign in {Icon.arrow}</>}
        </button>

        <a className="btn-ghost" href="/">← Back to the app</a>
      </form>
    </div>
  );
}

// ---------- Overview ----------

function StatCard({ label, value, tone, icon, onClick }) {
  const Tag = onClick ? "button" : "div";

  return (
    <Tag className={`stat ${tone ? `stat-${tone}` : ""}`} onClick={onClick}>
      <span className="stat-icon">{icon}</span>
      <strong>{value}</strong>
      <span>{label}</span>
    </Tag>
  );
}

function ReviewQueue({ count, goTo }) {
  const [payments, setPayments] = useState([]);

  useEffect(() => {
    fetchJson("/api/admin/payments?status=pending")
      .then((d) => setPayments(d.payments.slice(0, 5)))
      .catch(() => {});
  }, [count]);

  return (
    <section className="queue">
      <header>
        <h2>Waiting for review</h2>
        {payments.length > 0 && (
          <button className="btn-ghost" onClick={() => goTo("payments")}>
            Review all {Icon.arrow}
          </button>
        )}
      </header>

      {payments.length === 0 ? (
        <div className="empty-state">
          {Icon.check}
          <p>All caught up. New payments will show up here.</p>
        </div>
      ) : (
        <ul>
          {payments.map((p) => (
            <li key={p.id}>
              <span className="queue-avatar">{p.user.name.charAt(0).toUpperCase()}</span>
              <div>
                <strong>{p.user.name}</strong>
                <span>
                  {p.months} month{p.months === 1 ? "" : "s"} · {p.transactionRef} ·{" "}
                  {formatDate(p.createdAt, SHORT_DATE)}
                </span>
              </div>
              <strong className="queue-amount">{formatMoney(p.amount, p.currency)}</strong>
              <button className="btn-small" onClick={() => goTo("payments")}>
                Review
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Overview({ stats, settings, goTo }) {
  if (!stats) return <p className="muted">Loading…</p>;

  const revenue =
    stats.revenueThisMonth.length === 0
      ? formatMoney(0, settings?.currency || "USD")
      : stats.revenueThisMonth
          .map((r) => formatMoney(r.total, r.currency))
          .join(" + ");

  return (
    <>
      <div className="stats">
        <StatCard
          label="Payments to review"
          value={stats.pending}
          tone={stats.pending > 0 ? "attention" : null}
          icon={Icon.receipt}
          onClick={() => goTo("payments")}
        />
        <StatCard label="Active Pro users" value={stats.activePro} tone="pro" icon={Icon.sparkle} />
        <StatCard label="Registered users" value={stats.users} icon={Icon.users} onClick={() => goTo("users")} />
        <StatCard label="Approved this month" value={revenue} icon={Icon.bank} />
        <StatCard label="Free conversions used" value={stats.freeConversions} icon={Icon.film} />
      </div>

      {settings && !settings.accountNumber && (
        <div className="admin-callout">
          {Icon.alert}
          <p>
            <strong>Add your bank details</strong> so users can pay. Until
            then they&apos;ll see &quot;payment details haven&apos;t been set
            up yet&quot;.
          </p>
          <button className="btn-ghost" onClick={() => goTo("settings")}>
            Open settings
          </button>
        </div>
      )}

      <ReviewQueue count={stats.pending} goTo={goTo} />
    </>
  );
}

// ---------- Payments ----------

function ReceiptThumb({ payment, onOpen }) {
  const url = `/api/admin/payments/${payment.id}/receipt`;

  if (GATEWAYS[payment.method]) {
    return (
      <div className="receipt-thumb is-card">
        {Icon.card}
        <strong>{GATEWAYS[payment.method]}</strong>
        <small>{payment.gatewayMethod || "Card"}</small>
      </div>
    );
  }

  if (payment.receiptType === "application/pdf") {
    return (
      <a className="receipt-thumb is-pdf" href={url} target="_blank" rel="noreferrer">
        {Icon.receipt}
        <span>PDF receipt {Icon.external}</span>
      </a>
    );
  }

  return (
    <button className="receipt-thumb" onClick={() => onOpen(url)}>
      <img src={url} alt="Payment receipt" loading="lazy" />
      <span>View receipt</span>
    </button>
  );
}

function PaymentCard({ payment, settings, onReviewed, onOpenReceipt }) {
  const [months, setMonths] = useState(payment.months);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const expected = settings ? settings.price * payment.months : null;
  const short =
    expected !== null &&
    payment.currency === settings.currency &&
    payment.amount + 0.001 < expected;

  const act = async (action, body) => {
    setBusy(true);
    setError("");

    try {
      await fetchJson(`/api/admin/payments/${payment.id}/${action}`, {
        method: "POST",
        json: body,
      });
      await onReviewed();
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  return (
    <article className={`payment-card status-border-${payment.status}`}>
      <ReceiptThumb payment={payment} onOpen={onOpenReceipt} />

      <div className="payment-main">
        <header>
          <div>
            <strong>{payment.user.name}</strong>
            <span>{payment.user.email}</span>
          </div>
  <div className="pill-group">
            <span className="method-pill">{GATEWAYS[payment.method] || "Bank"}</span>
            <span className={`status-pill status-${payment.status}`}>
              {payment.status}
            </span>
          </div>
        </header>

        <dl className="payment-facts">
          <div>
            <dt>Amount</dt>
            <dd className={short ? "is-short" : ""}>
              {formatMoney(payment.amount, payment.currency)}
              {short && (
                <small>expected {formatMoney(expected, settings.currency)}</small>
              )}
            </dd>
          </div>
          <div>
            <dt>Plan</dt>
            <dd>{payment.months} month{payment.months === 1 ? "" : "s"}</dd>
          </div>
          <div>
            <dt>{GATEWAYS[payment.method] ? `${GATEWAYS[payment.method]} payment ID` : "Transaction ID"}</dt>
            <dd className="mono">{payment.transactionRef || "—"}</dd>
          </div>
          <div>
            <dt>{GATEWAYS[payment.method] ? "Order ID" : "Pay reference"}</dt>
            <dd className="mono">{GATEWAYS[payment.method] ? payment.orderId : payment.user.payRef}</dd>
          </div>
          <div>
            <dt>Paid on</dt>
            <dd>{payment.paidOn ? formatDate(payment.paidOn, SHORT_DATE) : "—"}</dd>
          </div>
          <div>
            <dt>Submitted</dt>
            <dd>{formatDate(payment.createdAt, SHORT_DATE)}</dd>
          </div>
        </dl>

        {payment.note && <p className="payment-note">“{payment.note}”</p>}

        {payment.status === "pending" && payment.user.proUntil && (
          <p className="payment-meta">
            Already Pro until {formatDate(payment.user.proUntil, SHORT_DATE)}.
            Approving adds time on top.
          </p>
        )}

        {GATEWAYS[payment.method] ? (
          <p className="payment-meta">
            {payment.status === "approved"
              ? `Paid online and confirmed by ${GATEWAYS[payment.method]} automatically. No action needed.`
              : payment.status === "chargedback"
                ? "Charged back: the Pro time from this payment was removed."
                : `${GATEWAYS[payment.method]} checkout ${payment.status}.`}
            {payment.adminNote && ["cancelled", "failed"].includes(payment.status) && <> · “{payment.adminNote}”</>}
          </p>
        ) : payment.status !== "pending" ? (
          <p className="payment-meta">
            {payment.status === "approved" ? "Approved" : "Rejected"} on{" "}
            {formatDate(payment.reviewedAt, SHORT_DATE)}
            {payment.adminNote && <> · “{payment.adminNote}”</>}
          </p>
        ) : rejecting ? (
          <div className="payment-actions">
            <input
              className="reason-input"
              placeholder="Reason the user will see, e.g. amount not received"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              maxLength={500}
              autoFocus
            />
            <button className="btn-danger" disabled={busy || !reason.trim()} onClick={() => act("reject", { note: reason })}>
              Reject payment
            </button>
            <button className="btn-ghost" onClick={() => setRejecting(false)}>
              Cancel
            </button>
          </div>
        ) : (
          <div className="payment-actions">
            <select value={months} onChange={(e) => setMonths(Number(e.target.value))} aria-label="Months of Pro to grant">
              {PLAN_MONTHS.map((m) => (
                <option key={m} value={m}>
                  {m} month{m === 1 ? "" : "s"}
                </option>
              ))}
            </select>
            <button className="btn-approve" disabled={busy} onClick={() => act("approve", { months })}>
              {Icon.check} Approve &amp; unlock Pro
            </button>
            <button className="btn-ghost" disabled={busy} onClick={() => setRejecting(true)}>
              Reject
            </button>
          </div>
        )}

        {error && <p className="form-error">{error}</p>}
      </div>
    </article>
  );
}

function Payments({ settings, onChanged }) {
  const [status, setStatus] = useState("pending");
  const [payments, setPayments] = useState(null);
  const [receipt, setReceipt] = useState(null);
  const closeReceipt = useCallback(() => setReceipt(null), []);

  const load = useCallback(
    () =>
      fetchJson(`/api/admin/payments?status=${status}`).then((d) =>
        setPayments(d.payments)
      ),
    [status]
  );

  useEffect(() => {
    setPayments(null);
    load();
  }, [load]);

  const reviewed = async () => {
    await Promise.all([load(), onChanged()]);
  };

  return (
    <>
      <div className="segmented-tabs" role="tablist">
        {["pending", "approved", "rejected", "all"].map((s) => (
          <button key={s} role="tab" aria-selected={status === s} className={status === s ? "is-active" : ""} onClick={() => setStatus(s)}>
            {s}
          </button>
        ))}
      </div>

      {payments === null && <p className="muted">Loading…</p>}

      {payments?.length === 0 && (
        <div className="empty-state">
          {Icon.check}
          <p>
            {status === "pending"
              ? "All caught up. No payments waiting for review."
              : "Nothing here yet."}
          </p>
        </div>
      )}

      <div className="payment-list">
        {payments?.map((p) => (
          <PaymentCard key={p.id} payment={p} settings={settings} onReviewed={reviewed} onOpenReceipt={setReceipt} />
        ))}
      </div>

      {receipt && (
        <Modal onClose={closeReceipt} labelledBy="receipt-title" className="receipt-modal">
          <h2 id="receipt-title" className="sr-only">Payment receipt</h2>
          <img src={receipt} alt="Payment receipt" />
        </Modal>
      )}
    </>
  );
}

// ---------- Users ----------

function UserRow({ user, onChanged }) {
  const [months, setMonths] = useState(1);
  const [busy, setBusy] = useState(false);
  const isAdminRow = user.role === "admin";
  // You, and the owner account from ADMIN_EMAIL, can't be changed here.
  const locked = user.isYou || user.isOwner;

  const act = async (path, init) => {
    setBusy(true);

    try {
      await fetchJson(`/api/admin/users/${user.id}${path}`, init);
      await onChanged();
    } catch (err) {
      alert(err.message);
    } finally {
      setBusy(false);
    }
  };

  const changeRole = (role) => {
    const question =
      role === "admin"
        ? `Make ${user.email} an admin? They will be able to manage users and payments.`
        : `Remove admin rights from ${user.email}?`;

    if (confirm(question)) act("/role", { method: "POST", json: { role } });
  };

  const remove = () => {
    if (confirm(`Delete ${user.email}?

Their account, payments and receipts are removed permanently. This can't be undone.`)) {
      act("", { method: "DELETE" });
    }
  };

  return (
    <tr>
      <td>
        <strong>{user.name}</strong>
        <span>{user.email}</span>
        {user.isOwner && <em className="role-chip">owner</em>}
        {!user.isOwner && isAdminRow && <em className="role-chip">admin</em>}
        {user.isYou && <em className="role-chip is-you">you</em>}
      </td>
      <td>
        {isAdminRow ? (
          <span className="status-pill status-approved">Admin · unlimited</span>
        ) : user.proUntil ? (
          <span className="status-pill status-approved">
            Pro · {formatDate(user.proUntil, SHORT_DATE)}
          </span>
        ) : (
          <span className="status-pill">Free</span>
        )}
      </td>
      <td className="mono">{user.payRef}</td>
      <td>{user.freeUses}</td>
      <td>{user.paidCount}</td>
      <td>{formatDate(user.createdAt, SHORT_DATE)}</td>
      <td>
        {isAdminRow ? (
          <span className="muted">Full access</span>
        ) : user.proUntil ? (
          <button
            className="btn-small is-danger"
            disabled={busy}
            onClick={() => {
              if (confirm(`Remove Pro from ${user.email}?`)) act("/revoke", { method: "POST", json: {} });
            }}
          >
            Revoke Pro
          </button>
        ) : (
          <div className="row-actions">
            <select value={months} onChange={(e) => setMonths(Number(e.target.value))} aria-label="Months">
              {PLAN_MONTHS.map((m) => (
                <option key={m} value={m}>{m} mo</option>
              ))}
            </select>
            <button className="btn-small" disabled={busy} onClick={() => act("/grant", { method: "POST", json: { months } })}>
              Grant Pro
            </button>
          </div>
        )}
      </td>
      <td>
        {locked ? (
          <span className="muted">—</span>
        ) : (
          <div className="row-actions">
            <button className="btn-small" disabled={busy} onClick={() => changeRole(isAdminRow ? "user" : "admin")}>
              {isAdminRow ? "Make user" : "Make admin"}
            </button>
            <button className="btn-small is-danger" disabled={busy} onClick={remove} aria-label={`Delete ${user.email}`}>
              Delete
            </button>
          </div>
        )}
      </td>
    </tr>
  );
}

function Users({ onChanged }) {
  const [query, setQuery] = useState("");
  const [users, setUsers] = useState(null);

  const load = useCallback(
    () =>
      fetchJson(`/api/admin/users?q=${encodeURIComponent(query)}`).then((d) =>
        setUsers(d.users)
      ),
    [query]
  );

  useEffect(() => {
    const t = setTimeout(load, 250);
    return () => clearTimeout(t);
  }, [load]);

  const changed = async () => {
    await Promise.all([load(), onChanged()]);
  };

  return (
    <>
      <input
        className="search"
        type="search"
        placeholder="Search by name, email or pay reference"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />

      {users === null ? (
        <p className="muted">Loading…</p>
      ) : (
        <div className="table-wrap">
          <table className="users-table">
            <thead>
              <tr>
                <th>User</th>
                <th>Plan</th>
                <th>Pay ref</th>
                <th>Free uses</th>
                <th>Payments</th>
                <th>Joined</th>
                <th>Pro access</th>
                <th>Account</th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <UserRow key={u.id} user={u} onChanged={changed} />
              ))}
            </tbody>
          </table>
          {users.length === 0 && <p className="muted pad">No users found.</p>}
        </div>
      )}
    </>
  );
}

// ---------- Settings ----------

function PayPalStatus({ status, currency }) {
  if (!status) return null;

  const problems = [];

  if (!status.configured) {
    problems.push("Add PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET (from developer.paypal.com → Apps & Credentials) to the environment variables, then redeploy.");
  }

  if (!status.currencySupported || String(currency).toUpperCase() === "LKR") {
    problems.push("PayPal doesn't accept LKR. Use USD (or another PayPal currency) above.");
  }

  const ready = problems.length === 0;

  return (
    <section className={`payhere-status ${ready ? "is-ready" : ""}`}>
      <h3>
        {Icon.card} PayPal payments
        <span className={`status-pill ${ready ? "status-approved" : "status-pending"}`}>
          {ready ? (status.sandbox ? "Ready · sandbox" : "Live") : "Not ready"}
        </span>
      </h3>

      {ready ? (
        <p className="form-hint">
          Buyers pay on PayPal and Pro unlocks as soon as they return.{" "}
          {status.sandbox && "Sandbox mode: use your PayPal sandbox buyer account, no real money."}
        </p>
      ) : (
        <ul className="payhere-problems">
          {problems.map((p) => <li key={p}>{p}</li>)}
        </ul>
      )}
    </section>
  );
}

function PayHereStatus({ status, currency }) {
  // PayHere is optional: hide it entirely until it's being set up.
  if (!status?.configured) return null;

  const problems = [];

  if (!status.configured) {
    problems.push("Add PAYHERE_MERCHANT_ID and PAYHERE_MERCHANT_SECRET to the .env file, then restart the server.");
  }

  if (!["LKR", "USD"].includes(String(currency).toUpperCase())) {
    problems.push("PayHere only accepts LKR or USD. Change the currency above.");
  }

  if (status.publicUrlLooksLocal) {
    problems.push("PayHere can't reach localhost to confirm payments. Set PUBLIC_URL in .env to your real https domain.");
  }

  const ready = problems.length === 0;

  return (
    <section className={`payhere-status ${ready ? "is-ready" : ""}`}>
      <h3>
        {Icon.card} PayHere card payments
        <span className={`status-pill ${ready ? "status-approved" : "status-pending"}`}>
          {ready ? (status.sandbox ? "Ready · sandbox" : "Live") : "Not ready"}
        </span>
      </h3>

      {ready ? (
        <p className="form-hint">
          Card payments unlock Pro automatically. {status.sandbox && "Sandbox mode: payments are tests, no real money. Set PAYHERE_SANDBOX=false in .env to go live."}
        </p>
      ) : (
        <ul className="payhere-problems">
          {problems.map((p) => <li key={p}>{p}</li>)}
        </ul>
      )}

      {status.notifyUrl && (
        <p className="form-hint">
          Notify URL: <code>{status.notifyUrl}</code>
        </p>
      )}
    </section>
  );
}

function Settings({ settings, onSaved }) {
  const [form, setForm] = useState(settings);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");

  useEffect(() => setForm(settings), [settings]);

  if (!form) return <p className="muted">Loading…</p>;

  const field = (key, label, props = {}) => (
    <label className="form-field">
      <span>{label}</span>
      <input value={form[key] ?? ""} onChange={(e) => setForm({ ...form, [key]: e.target.value })} {...props} />
    </label>
  );

  const save = async (e) => {
    e.preventDefault();
    setStatus("saving");
    setError("");

    try {
      await fetchJson("/api/admin/settings", { method: "PUT", json: form });
      await onSaved();
      setStatus("saved");
      setTimeout(() => setStatus(""), 2000);
    } catch (err) {
      setError(err.message);
      setStatus("");
    }
  };

  return (
    <form className="form settings-form" onSubmit={save}>
      <section>
        <h3>Pro plan</h3>
        <div className="form-row">
          {field("price", "Monthly price", { type: "number", min: "0.01", step: "0.01", required: true })}
          {field("currency", "Currency code", { maxLength: 3, required: true, placeholder: "USD" })}
        </div>
      </section>

      <section>
        <h3>Bank transfer details</h3>
        <p className="form-hint">Shown to users when they upgrade.</p>
        <div className="form-row">
          {field("bankName", "Bank")}
          {field("branch", "Branch")}
        </div>
        <div className="form-row">
          {field("accountName", "Account name")}
          {field("accountNumber", "Account number")}
        </div>
      </section>

      <PayPalStatus status={settings.paypal} currency={form.currency} />
      <PayHereStatus status={settings.payhere} currency={form.currency} />

      {error && <p className="form-error">{error}</p>}

      <button className="btn-primary" disabled={status === "saving"}>
        {status === "saving" ? "Saving…" : status === "saved" ? <>{Icon.check} Saved</> : "Save settings"}
      </button>
    </form>
  );
}

// ---------- Shell ----------

const TABS = [
  { id: "overview", label: "Overview", icon: Icon.aperture },
  { id: "payments", label: "Payments", icon: Icon.receipt },
  { id: "users", label: "Users", icon: Icon.users },
  { id: "settings", label: "Settings", icon: Icon.settings },
];

export default function AdminApp() {
  useTheme();

  const [me, setMe] = useState(undefined);
  const [tab, setTab] = useState(() => location.hash.slice(1) || "overview");
  const [stats, setStats] = useState(null);
  const [settings, setSettings] = useState(null);

  const loadMe = useCallback(
    () => fetchJson("/api/me").then((d) => setMe(d.user)).catch(() => setMe(null)),
    []
  );

  const isAdmin = me?.role === "admin";

  const loadStats = useCallback(() => fetchJson("/api/admin/stats").then(setStats), []);
  const loadSettings = useCallback(() => fetchJson("/api/admin/settings").then(setSettings), []);

  useEffect(() => {
    loadMe();
  }, [loadMe]);

  useEffect(() => {
    if (!isAdmin) return;

    loadStats();
    loadSettings();

    const interval = setInterval(loadStats, 30000);
    return () => clearInterval(interval);
  }, [isAdmin, loadStats, loadSettings]);

  const goTo = (id) => {
    setTab(id);
    history.replaceState(null, "", `#${id}`);
  };

  const signOut = async () => {
    await fetchJson("/api/auth/logout", { method: "POST" }).catch(() => {});
    setMe(null);
  };

  if (me === undefined) {
    return <div className="admin-gate"><p className="muted">Loading…</p></div>;
  }

  if (!isAdmin) {
    return <AdminLogin onLoggedIn={loadMe} notAdmin={Boolean(me)} />;
  }

  const current = TABS.find((t) => t.id === tab) || TABS[0];

  return (
    <div className="admin">
      <aside className="admin-nav">
        <div className="admin-brand">
          <span className="brand-mark">{Icon.aperture}</span>
          <div>
            <strong>Lab console</strong>
            <span>Image Converter Pro</span>
          </div>
        </div>

        <nav>
          {TABS.map((t) => (
            <button key={t.id} className={current.id === t.id ? "is-active" : ""} onClick={() => goTo(t.id)}>
              {t.icon}
              <span>{t.label}</span>
              {t.id === "payments" && stats?.pending > 0 && <em>{stats.pending}</em>}
            </button>
          ))}
        </nav>

        <div className="admin-me">
          <span>{me.email}</span>
          <a href="/">Open app</a>
          <button onClick={signOut}>Sign out</button>
        </div>
      </aside>

      <main className="admin-main">
        <header className="admin-header">
          <span className="eyebrow">Admin</span>
          <h1>{current.label}</h1>
        </header>

        {current.id === "overview" && <Overview stats={stats} settings={settings} goTo={goTo} />}
        {current.id === "payments" && <Payments settings={settings} onChanged={loadStats} />}
        {current.id === "users" && <Users onChanged={loadStats} />}
        {current.id === "settings" && <Settings settings={settings} onSaved={loadSettings} />}
      </main>
    </div>
  );
}
