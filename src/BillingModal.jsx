import { useEffect, useRef, useState } from "react";
import Modal from "./Modal.jsx";
import { Icon } from "./icons.jsx";
import { fetchJson, formatDate, formatMoney, uploadFile } from "./api.js";

const STATUS_LABEL = {
  pending: "Under review",
  approved: "Approved",
  rejected: "Rejected",
  cancelled: "Cancelled",
  failed: "Failed",
  chargedback: "Charged back",
};

const SHORT_DATE = { day: "numeric", month: "short", year: "numeric" };

function today() {
  const d = new Date();

  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 10);
}

function CopyButton({ value }) {
  const [copied, setCopied] = useState(false);

  return (
    <button
      type="button"
      className={`copy-btn ${copied ? "is-copied" : ""}`}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          // clipboard unavailable; the value is still selectable
        }
      }}
      aria-label={`Copy ${value}`}
    >
      {copied ? Icon.check : Icon.copy}
    </button>
  );
}

function PaymentHistory({ payments }) {
  if (payments.length === 0) return null;

  return (
    <details className="history">
      <summary>Payment history ({payments.length})</summary>
      <ul>
        {payments.map((p) => (
          <li key={p.id}>
            <div>
              <strong>{formatMoney(p.amount, p.currency)}</strong>
              <span>
                {p.months} month{p.months === 1 ? "" : "s"} ·{" "}
                {{ payhere: "card (PayHere)", paypal: "PayPal" }[p.method] || "bank transfer"} ·{" "}
                {formatDate(p.createdAt, SHORT_DATE)}
              </span>
              {p.status === "rejected" && p.adminNote && (
                <em>“{p.adminNote}”</em>
              )}
            </div>
            <span className={`status-pill status-${p.status}`}>
              {STATUS_LABEL[p.status] || p.status}
            </span>
          </li>
        ))}
      </ul>
    </details>
  );
}

// PayHere needs a real form POST from the browser to its checkout page.
function submitToPayHere({ action, fields }) {
  const form = document.createElement("form");

  form.method = "POST";
  form.action = action;

  for (const [name, value] of Object.entries(fields)) {
    const input = document.createElement("input");

    input.type = "hidden";
    input.name = name;
    input.value = value;
    form.appendChild(input);
  }

  document.body.appendChild(form);
  form.submit();
}

// PayPal: the server creates an order, then the buyer approves it on PayPal.
function PayPalForm({ months, total, promoCode }) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const pay = async () => {
    setBusy(true);
    setError("");

    try {
      const { url } = await fetchJson("/api/billing/paypal/checkout", {
        method: "POST",
        json: { months, promoCode },
      });

      window.location.href = url;
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  return (
    <div className="form method-form">
      {error && <p className="form-error">{error}</p>}

      <button type="button" className="btn-primary btn-paypal" onClick={pay} disabled={busy}>
        {busy ? "Opening PayPal…" : <>Pay {total} with PayPal {Icon.arrow}</>}
      </button>
    </div>
  );
}

function CardForm({ months, total, promoCode }) {
  const [form, setForm] = useState({ phone: "", address: "", city: "", country: "Sri Lanka" });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const update = (key) => (e) =>
    setForm((current) => ({ ...current, [key]: e.target.value }));

  const pay = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError("");

    try {
      const checkout = await fetchJson("/api/billing/payhere/checkout", {
        method: "POST",
        json: { months, promoCode, ...form },
      });

      submitToPayHere(checkout);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  return (
    <form className="form method-form" onSubmit={pay}>
      <label className="form-field">
        <span>Phone number</span>
        <input type="tel" value={form.phone} onChange={update("phone")} placeholder="07X XXX XXXX" autoComplete="tel" required />
      </label>

      <label className="form-field">
        <span>Address</span>
        <input value={form.address} onChange={update("address")} autoComplete="street-address" maxLength={200} required />
      </label>

      <div className="form-row">
        <label className="form-field">
          <span>City</span>
          <input value={form.city} onChange={update("city")} autoComplete="address-level2" maxLength={80} required />
        </label>

        <label className="form-field">
          <span>Country</span>
          <input value={form.country} onChange={update("country")} autoComplete="country-name" maxLength={60} required />
        </label>
      </div>

      {error && <p className="form-error">{error}</p>}

      <button className="btn-primary" disabled={busy}>
        {busy ? "Opening PayHere…" : <>{Icon.lock} Pay {total} securely {Icon.arrow}</>}
      </button>
    </form>
  );
}

function BankForm({ account, billing, months, total, amountDue, promoCode, onSubmitted }) {
  const [form, setForm] = useState({
    amount: String(amountDue),
    transactionRef: "",
    paidOn: today(),
    note: "",
  });
  const [receipt, setReceipt] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const receiptInput = useRef(null);
  const bank = billing.bank;

  // Keep the amount in step with the chosen plan and discount.
  useEffect(() => {
    setForm((f) => ({ ...f, amount: String(amountDue) }));
  }, [amountDue]);

  const update = (key) => (e) =>
    setForm((current) => ({ ...current, [key]: e.target.value }));

  const submit = async (e) => {
    e.preventDefault();

    if (!receipt) {
      setError("Attach a photo or PDF of your payment receipt.");
      return;
    }

    setBusy(true);
    setError("");

    try {
      // The receipt goes to storage first; the payment then refers to it.
      const receiptPath = await uploadFile(receipt, { account, purpose: "receipt" });

      await fetchJson("/api/billing/payments", {
        method: "POST",
        json: { ...form, months, receiptPath, promoCode },
      });
      await onSubmitted();
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  return (
    <form className="form method-form" onSubmit={submit}>
      <h4>Transfer {total} to</h4>

      <dl className="bank">
        {[
          ["Bank", bank.bankName],
          ["Account name", bank.accountName],
          ["Account no.", bank.accountNumber],
          ["Branch", bank.branch],
        ]
          .filter(([, v]) => v)
          .map(([label, value]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>
                {value}
                <CopyButton value={value} />
              </dd>
            </div>
          ))}
      </dl>

      <div className="ticket">
        <span>Your payment reference</span>
        <div>
          <strong>{billing.payRef}</strong>
          <CopyButton value={billing.payRef} />
        </div>
      </div>

      <h4>Then upload your receipt</h4>

      <div className="form-row">
        <label className="form-field">
          <span>Amount paid ({billing.currency})</span>
          <input type="number" min="0" step="0.01" value={form.amount} onChange={update("amount")} required />
        </label>

        <label className="form-field">
          <span>Payment date</span>
          <input type="date" value={form.paidOn} max={today()} onChange={update("paidOn")} required />
        </label>
      </div>

      <label className="form-field">
        <span>Transaction ID / bank reference</span>
        <input value={form.transactionRef} onChange={update("transactionRef")} maxLength={100} placeholder="e.g. FT2629304512" required />
      </label>

      <input
        ref={receiptInput}
        type="file"
        accept="image/jpeg,image/png,image/webp,application/pdf"
        hidden
        onChange={(e) => {
          const file = e.target.files[0];

          if (file && file.size > 5 * 1024 * 1024) {
            setError("Receipt must be smaller than 5 MB.");
            return;
          }

          setReceipt(file || null);
          setError("");
        }}
      />

      <button
        type="button"
        className={`receipt-drop ${receipt ? "has-file" : ""}`}
        onClick={() => receiptInput.current.click()}
      >
        {receipt ? Icon.check : Icon.upload}
        <span>{receipt ? receipt.name : "Attach receipt (photo or PDF, max 5 MB)"}</span>
      </button>

      <label className="form-field">
        <span>Note for the admin (optional)</span>
        <textarea value={form.note} onChange={update("note")} maxLength={500} />
      </label>

      {error && <p className="form-error">{error}</p>}

      <button className="btn-primary" disabled={busy}>
        {busy ? "Sending…" : <>Submit for review {Icon.arrow}</>}
      </button>
    </form>
  );
}

export default function BillingModal({ account, onClose, onSubmitted }) {
  const [billing, setBilling] = useState(null);
  const [loadError, setLoadError] = useState("");
  const [months, setMonths] = useState(1);
  const [method, setMethod] = useState(null);
  const [promoInput, setPromoInput] = useState("");
  const [promoCode, setPromoCode] = useState("");
  const [promoError, setPromoError] = useState("");
  const [quote, setQuote] = useState(null);
  const [claiming, setClaiming] = useState(false);

  // The server works out the price (sale, promo code or invite discount).
  useEffect(() => {
    if (!billing) return;

    let cancelled = false;

    fetchJson(`/api/promo/quote?months=${months}&code=${encodeURIComponent(promoCode)}`)
      .then((q) => !cancelled && setQuote(q))
      .catch((err) => {
        if (cancelled) return;
        setPromoError(err.message);
        setPromoCode("");
      });

    return () => {
      cancelled = true;
    };
  }, [billing, months, promoCode]);

  const applyPromo = (e) => {
    e.preventDefault();
    setPromoError("");
    setPromoCode(promoInput.trim().toUpperCase());
  };

  const claimFree = async () => {
    setClaiming(true);
    setPromoError("");

    try {
      await fetchJson("/api/promo/claim-free", { method: "POST", json: { months, code: promoCode } });
      await onSubmitted();
    } catch (err) {
      setPromoError(err.message);
    } finally {
      setClaiming(false);
    }
  };

  useEffect(() => {
    fetchJson("/api/billing")
      .then((data) => {
        setBilling(data);
        setMethod((m) =>
          m ||
          (data.methods.paypal ? "paypal" : data.methods.payhere ? "payhere" : data.methods.bank ? "bank" : null)
        );
      })
      .catch((err) => setLoadError(err.message));
  }, [account.latestPayment?.status, account.plan]);

  const latest = account.latestPayment;
  const isPending = latest?.status === "pending";
  const isPro = account.plan === "pro";
  const methods = billing?.methods;
  const noMethods = methods && !methods.paypal && !methods.payhere && !methods.bank;
  const amountDue = quote ? quote.total : billing ? Math.round(billing.price * months * 100) / 100 : 0;
  const total = billing ? formatMoney(amountDue, billing.currency) : "";
  const campaignPercent = account.campaign?.discountPercent || 0;
  const isFree = quote && quote.total === 0;

  return (
    <Modal onClose={onClose} labelledBy="billing-title" className="billing-modal">
      <div className="modal-body">
        {!billing && !loadError && <p className="modal-lead">Loading…</p>}
        {loadError && <p className="form-error">{loadError}</p>}

        {billing && isPending && (
          <div className="tray-view">
            <div className="tray" aria-hidden="true">
              <div className="tray-liquid" />
              <div className="tray-photo">
                <span>{Icon.sparkle}</span>
                <strong>PRO</strong>
              </div>
            </div>

            <span className="eyebrow">Payment received</span>
            <h2 id="billing-title">Your Pro pass is in the developing tray</h2>
            <p className="modal-lead">Pro unlocks as soon as your transfer is confirmed.</p>

            <PaymentHistory payments={billing.payments} />
          </div>
        )}

        {billing && !isPending && (
          <>
            <span className="eyebrow">{isPro ? "Extend your plan" : "Go Pro"}</span>
            <h2 id="billing-title">{isPro ? "You're Pro" : "Get your Pro pass"}</h2>
            <p className="modal-lead">
              {isPro
                ? `Active until ${formatDate(account.proUntil)}.`
                : "Unlimited conversions, bigger batches."}
            </p>

            {latest?.status === "rejected" && (
              <div className="rejected-note">
                {Icon.alert}
                <div>
                  <strong>Your last bank transfer wasn&apos;t approved</strong>
                  <p>{latest.adminNote}</p>
                </div>
              </div>
            )}

            {noMethods ? (
              <p className="form-error">
                Payments haven&apos;t been set up yet. Please check back soon.
              </p>
            ) : (
              <div className="form">
                <div className="step">
                  <span className="step-num">1</span>
                  <div className="step-content">
                    <h3>Choose your plan</h3>
                    <div className="plan-options">
                      {billing.planMonths.map((m) => (
                        <button
                          type="button"
                          key={m}
                          className={months === m ? "is-active" : ""}
                          onClick={() => setMonths(m)}
                        >
                          <strong>{m} mo</strong>
                          {campaignPercent > 0 && (
                            <s>{formatMoney(billing.price * m, billing.currency)}</s>
                          )}
                          <span>{formatMoney(billing.price * m * (1 - campaignPercent / 100), billing.currency)}</span>
                        </button>
                      ))}
                    </div>

                    {quote && (
                      <div className="price-summary">
                        {quote.discount > 0 && (
                          <>
                            <div><span>Price</span><span>{formatMoney(quote.listAmount, quote.currency)}</span></div>
                            <div className="is-discount">
                              <span>{Icon.tag} {quote.discountLabel}</span>
                              <span>−{formatMoney(quote.discount, quote.currency)}</span>
                            </div>
                          </>
                        )}
                        <div className="is-total"><span>Total</span><span>{formatMoney(quote.total, quote.currency)}</span></div>
                      </div>
                    )}

                    <form className="promo-form" onSubmit={applyPromo}>
                      <input
                        value={promoInput}
                        onChange={(e) => setPromoInput(e.target.value.toUpperCase())}
                        placeholder="Promo code"
                        aria-label="Promo code"
                        maxLength={30}
                      />
                      {promoCode ? (
                        <button type="button" className="btn-small" onClick={() => { setPromoCode(""); setPromoInput(""); }}>
                          Remove
                        </button>
                      ) : (
                        <button className="btn-small" disabled={!promoInput.trim()}>Apply</button>
                      )}
                    </form>
                    {promoError && <p className="form-error">{promoError}</p>}
                    {quote?.promoBeaten && (
                      <p className="form-hint">A better discount is already applied.</p>
                    )}
                  </div>
                </div>

                {isFree ? (
                  <button type="button" className="btn-primary" onClick={claimFree} disabled={claiming}>
                    {claiming ? "Activating…" : <>{Icon.sparkle} Activate Pro free</>}
                  </button>
                ) : (
                <>

                <div className="step">
                  <span className="step-num">2</span>
                  <div className="step-content">
                    <h3>How would you like to pay?</h3>

                    <div className="method-options" role="radiogroup">
                      {methods.paypal && (
                        <button
                          type="button"
                          role="radio"
                          aria-checked={method === "paypal"}
                          className={method === "paypal" ? "is-active" : ""}
                          onClick={() => setMethod("paypal")}
                        >
                          <span className="method-icon">{Icon.card}</span>
                          <strong>PayPal</strong>
                          <small>PayPal balance or debit/credit card</small>
                          <em className="method-tag is-instant">Instant</em>
                        </button>
                      )}

                      {methods.payhere && (
                        <button
                          type="button"
                          role="radio"
                          aria-checked={method === "payhere"}
                          className={method === "payhere" ? "is-active" : ""}
                          onClick={() => setMethod("payhere")}
                        >
                          <span className="method-icon">{Icon.card}</span>
                          <strong>Card / PayHere</strong>
                          <small>Visa, Mastercard, Amex, mobile wallets</small>
                          <em className="method-tag is-instant">Instant</em>
                        </button>
                      )}

                      {methods.bank && (
                        <button
                          type="button"
                          role="radio"
                          aria-checked={method === "bank"}
                          className={method === "bank" ? "is-active" : ""}
                          onClick={() => setMethod("bank")}
                        >
                          <span className="method-icon">{Icon.bank}</span>
                          <strong>Bank transfer</strong>
                          <small>Upload your receipt, we confirm it</small>
                          <em className="method-tag">Within a few hours</em>
                        </button>
                      )}
                    </div>
                  </div>
                </div>

                <div className="step">
                  <span className="step-num">3</span>
                  <div className="step-content">
                    <h3>{method === "bank" ? "Transfer & upload" : `Pay ${total}`}</h3>

                    {method === "paypal" && (
                      <PayPalForm months={months} total={total} promoCode={promoCode} />
                    )}

                    {method === "payhere" && (
                      <CardForm months={months} total={total} promoCode={promoCode} />
                    )}

                    {method === "bank" && (
                      <BankForm
                        account={account}
                        billing={billing}
                        months={months}
                        total={total}
                        amountDue={amountDue}
                        promoCode={promoCode}
                        onSubmitted={onSubmitted}
                      />
                    )}
                  </div>
                </div>
                </>
                )}
              </div>
            )}

            <PaymentHistory payments={billing.payments} />
          </>
        )}
      </div>
    </Modal>
  );
}
