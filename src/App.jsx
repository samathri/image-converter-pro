import { useCallback, useEffect, useRef, useState } from "react";
import "./App.css";
import { Icon } from "./icons.jsx";
import Paywall from "./Paywall.jsx";
import AuthModal from "./AuthModal.jsx";
import BillingModal from "./BillingModal.jsx";
import ReferralModal from "./ReferralModal.jsx";
import AccountMenu from "./AccountMenu.jsx";
import { downloadFile, fetchJson, formatDate, uploadFile } from "./api.js";
import "./Account.css";

const FORMATS = [
  { id: "AVIF", note: "Smallest files" },
  { id: "WEBP", note: "Best all-rounder" },
  { id: "JPEG", note: "Universal photos" },
  { id: "JPG", note: "JPEG, .jpg name" },
  { id: "PNG", note: "Palette, lossless-ish" },
];

const PRESETS = [
  { size: 50, unit: "KB" },
  { size: 100, unit: "KB" },
  { size: 250, unit: "KB" },
  { size: 500, unit: "KB" },
  { size: 1, unit: "MB" },
  { size: 2, unit: "MB" },
];

const ACCEPT = ".jpg,.jpeg,.png,.webp,.avif";

let nextId = 0;

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function isValidUrl(value) {
  try {
    return ["http:", "https:"].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

// Topbar meter: each free conversion is a "roll of film".
// Whole days left until a date (at least 1 while it hasn't passed).
function daysLeft(iso) {
  return Math.max(1, Math.ceil((new Date(iso) - Date.now()) / 864e5));
}

// "Your Pro plan ends in N days" / "Your Pro plan ended" banner.
function ExpiryBanner({ account, onRenew }) {
  const key = account?.proUntil || account?.proEndedAt;
  const [hidden, setHidden] = useState(() => {
    try {
      return sessionStorage.getItem("icp-expiry-dismissed") === key;
    } catch {
      return false;
    }
  });

  if (!account?.user || account.admin || hidden) return null;

  let text;

  if (account.plan === "pro" && account.proUntil && daysLeft(account.proUntil) <= 7) {
    const left = daysLeft(account.proUntil);

    text = `Your Pro plan ends in ${left} day${left === 1 ? "" : "s"} (${formatDate(account.proUntil, { day: "numeric", month: "short" })}).`;
  } else if (account.plan !== "pro" && account.proEndedAt) {
    text = `Your Pro plan ended on ${formatDate(account.proEndedAt, { day: "numeric", month: "short" })}.`;
  } else {
    return null;
  }

  const dismiss = () => {
    setHidden(true);

    try {
      sessionStorage.setItem("icp-expiry-dismissed", key);
    } catch {
      // storage unavailable: it just shows again next time
    }
  };

  return (
    <div className="expiry-banner" role="status">
      {Icon.clock}
      <span>{text}</span>
      <button type="button" className="expiry-renew" onClick={onRenew}>Renew Pro</button>
      <button type="button" className="expiry-close" onClick={dismiss} aria-label="Dismiss">{Icon.x}</button>
    </div>
  );
}

function RollMeter({ account, onUpgrade }) {
  if (!account) return null;

  if (account.admin) {
    return (
      <div className="roll-meter is-pro" title="Admins have unlimited access">
        <span className="pro-chip">{Icon.shield} Admin</span>
        <span className="roll-label">Unlimited access</span>
      </div>
    );
  }

  if (account.plan === "pro") {
    const renews = formatDate(account.proUntil, {
      day: "numeric",
      month: "short",
    });
    const left = daysLeft(account.proUntil);
    const ending = left <= 7;

    return (
      <button
        className={`roll-meter is-pro ${ending ? "is-expiring" : ""}`}
        onClick={onUpgrade}
        title={`Pro until ${renews}`}
      >
        <span className="pro-chip">{Icon.sparkle} Pro</span>
        <span className="roll-label">
          {ending ? `Ends in ${left} day${left === 1 ? "" : "s"}` : `Unlimited film · until ${renews}`}
        </span>
      </button>
    );
  }

  if (account.latestPayment?.status === "pending") {
    return (
      <button className="roll-meter is-pending" onClick={onUpgrade}>
        <span className="pending-dot" aria-hidden="true" />
        <span className="roll-label">Pro under review</span>
        <span className="roll-cta">{Icon.clock}</span>
      </button>
    );
  }

  const empty = account.usesLeft === 0;

  return (
    <button
      className={`roll-meter ${empty ? "is-empty" : ""}`}
      onClick={onUpgrade}
      title="Free rolls left. Each roll develops up to 5 images."
    >
      <span className="rolls" aria-hidden="true">
        {Array.from({ length: account.freeUses }).map((_, i) => (
          <i
            key={i}
            className={i < account.usesLeft ? "is-full" : ""}
          />
        ))}
      </span>
      <span className="roll-label">
        {empty
          ? "Out of free film"
          : `${account.usesLeft} free roll${account.usesLeft === 1 ? "" : "s"} left`}
      </span>
      <span className="roll-cta">Go Pro</span>
    </button>
  );
}


export default function App() {
  const [theme, setTheme] = useState(() => {
    try {
      return localStorage.getItem("icp-theme") || "dark";
    } catch {
      return "dark";
    }
  });
  const [files, setFiles] = useState([]);
  const [imageUrls, setImageUrls] = useState("");
  const [selectedFormats, setSelectedFormats] =
    useState(["WEBP"]);
  const [targetSize, setTargetSize] = useState(500);
  const [sizeUnit, setSizeUnit] = useState("KB");
  const [dragging, setDragging] = useState(false);
  // idle | uploading | converting
  const [phase, setPhase] = useState("idle");
  const [progress, setProgress] = useState(0);
  const [notice, setNotice] = useState(null);
  const [account, setAccount] = useState(null);
  // null | "exhausted" | "too-many" | "upgrade"
  const [paywall, setPaywall] = useState(null);
  // null | { mode: "login" | "register", reason?: string }
  const [auth, setAuth] = useState(null);
  const [billingOpen, setBillingOpen] = useState(false);
  const [inviteOpen, setInviteOpen] = useState(false);
  const previousPlan = useRef(null);
  // Read once: the URL is cleaned right after, but effects may re-run.
  const [paymentResult] = useState(() =>
    new URLSearchParams(window.location.search).get("payment")
  );
  // PayPal adds ?token=ORDER_ID when it sends the buyer back.
  const [paymentToken] = useState(() =>
    new URLSearchParams(window.location.search).get("token")
  );
  const paypalHandled = useRef(false);
  const fileInput = useRef(null);
  const filesRef = useRef(files);

  filesRef.current = files;

  useEffect(() => {
    document.documentElement.dataset.theme = theme;

    try {
      localStorage.setItem("icp-theme", theme);
    } catch {
      // storage unavailable, theme just won't persist
    }
  }, [theme]);

  const refreshAccount = useCallback(
    () =>
      fetchJson("/api/me")
        .then((data) => {
          setAccount(data);
          return data;
        })
        .catch(() => null),
    []
  );

  useEffect(() => {
    refreshAccount();
  }, [refreshAccount]);

  const pendingReview = account?.latestPayment?.status === "pending";

  // While a payment is under review, check back so Pro unlocks
  // without a page reload once the admin approves it.
  useEffect(() => {
    if (!pendingReview) return;

    const interval = setInterval(refreshAccount, 20000);
    const onFocus = () => refreshAccount();

    window.addEventListener("focus", onFocus);

    return () => {
      clearInterval(interval);
      window.removeEventListener("focus", onFocus);
    };
  }, [pendingReview, refreshAccount]);

  // Reminder emails link to /?renew=1: open billing (or sign-in first).
  // ?renew=1 comes from reminder emails, ?upgrade=1 from Google sign-up.
  const [renewRequested] = useState(() => {
    const params = new URLSearchParams(window.location.search);

    return params.has("renew") || params.has("upgrade");
  });

  useEffect(() => {
    if (!renewRequested || !account) return;

    history.replaceState(null, "", window.location.pathname);

    if (account.user && !account.admin) setBillingOpen(true);
    else if (!account.user) setAuth({ mode: "login", reason: "Sign in to renew your Pro plan." });
  }, [renewRequested, account?.user?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Google sign-in problems come back as ?auth_error=...
  useEffect(() => {
    const message = new URLSearchParams(window.location.search).get("auth_error");

    if (!message) return;

    history.replaceState(null, "", window.location.pathname);
    setNotice({ type: "error", title: "Sign-in didn't work", text: message });
  }, []);

  // Coming back from PayPal: capture the payment (once) and show the result.
  useEffect(() => {
    if (!paymentResult?.startsWith("paypal") || paypalHandled.current) return;

    paypalHandled.current = true;
    history.replaceState(null, "", window.location.pathname);

    if (paymentResult === "paypal-cancel") {
      fetchJson("/api/billing/paypal/cancel", { method: "POST", json: { orderId: paymentToken } }).catch(() => {});
      setNotice({
        type: "warn",
        title: "Payment cancelled",
        text: "No money was taken. You can try again any time.",
      });
      return;
    }

    setNotice({
      type: "warn",
      title: "Confirming your payment…",
      text: "Finishing your PayPal payment. This takes a few seconds.",
    });

    fetchJson("/api/billing/paypal/capture", { method: "POST", json: { orderId: paymentToken } })
      .then(async () => {
        const data = await refreshAccount();

        previousPlan.current = `${data?.user?.id ?? "anon"}:pro`;
        setNotice({
          type: "success",
          title: "Your Pro pass is ready!",
          text: `Payment confirmed. Unlimited film until ${formatDate(data?.proUntil)}.`,
        });
      })
      .catch((error) => {
        setNotice({ type: "error", title: "Payment not completed", text: error.message });
      });
  }, [paymentResult, paymentToken, refreshAccount]);

  // Coming back from PayHere: ?payment=return or ?payment=cancelled.
  useEffect(() => {
    const result = paymentResult;

    if (!result || result.startsWith("paypal")) return;

    history.replaceState(null, "", window.location.pathname);

    if (result === "cancelled") {
      setNotice({
        type: "warn",
        title: "Payment cancelled",
        text: "No money was taken. You can try again any time.",
      });
      return;
    }

    setNotice({
      type: "warn",
      title: "Confirming your payment…",
      text: "PayHere is confirming your payment. Pro will unlock here in a moment.",
    });

    // PayHere confirms to our server separately, so check until Pro shows up.
    let tries = 0;
    let stopped = false;

    const check = async () => {
      const data = await refreshAccount();

      if (stopped) return;

      if (data?.plan === "pro") {
        previousPlan.current = `${data.user?.id ?? "anon"}:pro`;
        setNotice({
          type: "success",
          title: "Your Pro pass is ready!",
          text: `Payment confirmed. Unlimited film until ${formatDate(data.proUntil)}.`,
        });
        return;
      }

      if (++tries < 40) {
        setTimeout(check, 3000);
      } else {
        setNotice({
          type: "warn",
          title: "Still waiting for PayHere",
          text: "Your payment hasn't been confirmed yet. If money was taken, Pro will unlock shortly. Contact us if it doesn't.",
        });
      }
    };

    check();

    return () => {
      stopped = true;
    };
  }, [paymentResult, refreshAccount]);

  // Celebrate when the same user's plan flips from free to Pro (a real
  // upgrade), not when someone signs in to an account that already has Pro.
  useEffect(() => {
    if (!account) return;

    const key = `${account.user?.id ?? "anon"}:${account.plan}`;
    const [prevUser, prevPlan] = (previousPlan.current || "").split(":");

    if (
      prevPlan === "free" &&
      account.plan === "pro" &&
      prevUser === String(account.user?.id ?? "anon") &&
      !account.admin
    ) {
      setNotice({
        type: "success",
        title: "Your Pro pass is ready!",
        text: `Your payment was confirmed. Unlimited film until ${formatDate(account.proUntil)}.`,
      });
    }

    previousPlan.current = key;
  }, [account]);

  // Release thumbnail URLs when the app unmounts.
  useEffect(
    () => () =>
      filesRef.current.forEach((f) =>
        URL.revokeObjectURL(f.preview)
      ),
    []
  );

  const urlLines = imageUrls
    .split("\n")
    .map((u) => u.trim())
    .filter(Boolean);
  const validUrls = urlLines.filter(isValidUrl);
  const invalidCount = urlLines.length - validUrls.length;

  const sourceCount = files.length + validUrls.length;
  const outputCount = sourceCount * selectedFormats.length;
  const totalBytes = files.reduce((sum, f) => sum + f.file.size, 0);
  const busy = phase !== "idle";

  const isFree = account?.plan === "free";
  const freeLimit = account?.maxImages ?? Infinity;
  const outOfFilm = isFree && account.usesLeft === 0;
  const overLimit = isFree && sourceCount > freeLimit;

  const addFiles = (fileList) => {
    const images = Array.from(fileList)
      .filter((file) =>
        /\.(jpe?g|png|webp|avif)$/i.test(file.name)
      )
      .map((file) => ({
        id: nextId++,
        file,
        preview: URL.createObjectURL(file),
      }));

    if (images.length > 0) {
      setFiles((current) => [...current, ...images]);
      setNotice(null);
    }
  };

  const removeFile = (id) => {
    const target = files.find((f) => f.id === id);

    if (target) URL.revokeObjectURL(target.preview);
    setFiles(files.filter((f) => f.id !== id));
  };

  const clearFiles = () => {
    files.forEach((f) => URL.revokeObjectURL(f.preview));
    setFiles([]);
  };

  const toggleFormat = (format) => {
    setSelectedFormats((current) =>
      current.includes(format)
        ? current.filter((f) => f !== format)
        : [...current, format]
    );
  };

  // Stable references so modal Escape listeners aren't re-added each render.
  const closePaywall = useCallback(() => setPaywall(null), []);
  const closeAuth = useCallback(() => setAuth(null), []);
  const closeBilling = useCallback(() => setBillingOpen(false), []);
  const closeInvite = useCallback(() => setInviteOpen(false), []);

  // Invite links (?ref=CODE): remember the inviter for when this visitor signs up.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const code = params.get("ref");

    if (!code) return;

    params.delete("ref");
    history.replaceState(null, "", window.location.pathname + (params.size ? `?${params}` : ""));
    fetchJson("/api/promo/referral/visit", { method: "POST", json: { code } }).catch(() => {});
  }, []);

  // Pro needs an account: sign up first, then pay.
  const startUpgrade = () => {
    setPaywall(null);

    if (account?.user) {
      setBillingOpen(true);
    } else {
      setAuth({ mode: "register", intent: "upgrade" });
    }
  };

  // After signing in: new accounts, and anyone who came from a Buy Pro
  // button or hit the free limit, go straight to the purchase window.
  const handleAuthed = async ({ created = false } = {}) => {
    const intent = auth?.intent;

    setAuth(null);

    const updated = await refreshAccount();

    if (
      updated?.user &&
      updated.plan !== "pro" &&
      !updated.admin &&
      (created || intent === "upgrade" || outOfFilm || overLimit)
    ) {
      setBillingOpen(true);
    }
  };

  const signOut = async () => {
    await fetchJson("/api/auth/logout", { method: "POST" }).catch(() => {});
    previousPlan.current = null;
    setBillingOpen(false);
    await refreshAccount();
  };

  // `limit` lets a free user develop only the first N sources.
  const convertImages = async (limit = Infinity) => {
    const sendFiles = files.slice(0, limit);
    const sendUrls = validUrls.slice(
      0,
      Math.max(0, limit - sendFiles.length)
    );

    if (sourceCount === 0) {
      setNotice({
        type: "error",
        title: "Nothing to develop yet",
        text: "Add some images or paste image URLs first.",
      });
      return;
    }

    if (selectedFormats.length === 0) {
      setNotice({
        type: "error",
        title: "Pick a format",
        text: "Select at least one output format.",
      });
      return;
    }

    if (!(Number(targetSize) > 0)) {
      setNotice({
        type: "error",
        title: "Check the target size",
        text: "Target size must be greater than 0.",
      });
      return;
    }

    if (outOfFilm) {
      setPaywall("exhausted");
      return;
    }

    if (isFree && sendFiles.length + sendUrls.length > freeLimit) {
      setPaywall("too-many");
      return;
    }

    setPaywall(null);

    setNotice(null);
    setProgress(0);
    setPhase("uploading");

    try {
      // 1. Upload the images to storage (straight to Vercel Blob in production).
      const totalBytes = sendFiles.reduce((sum, f) => sum + f.file.size, 0) || 1;
      const loaded = sendFiles.map(() => 0);
      const uploads = [];

      for (const [i, f] of sendFiles.entries()) {
        const pathname = await uploadFile(f.file, {
          account,
          onProgress: (p) => {
            loaded[i] = p * f.file.size;
            setProgress(loaded.reduce((a, b) => a + b, 0) / totalBytes);
          },
        });

        loaded[i] = f.file.size;
        uploads.push({ pathname, name: f.file.name });
      }

      // 2. Convert on the server, which returns a temporary download link.
      setProgress(1);
      setPhase("converting");

      const result = await fetchJson("/api/convert", {
        method: "POST",
        json: {
          uploads,
          imageUrls: sendUrls,
          formats: selectedFormats,
          targetSize,
          sizeUnit,
        },
      });

      await downloadFile(result.downloadUrl, result.filename);

      const filename = result.filename;
      const failedUrls = result.failedUrls;
      const updated = await fetchJson("/api/me").catch(() => null);
      let rollsText = "";

      if (updated) {
        setAccount(updated);

        if (updated.plan === "free") {
          rollsText =
            updated.usesLeft === 0
              ? " That was your last free roll."
              : ` ${updated.usesLeft} free roll${updated.usesLeft === 1 ? "" : "s"} left.`;
        }
      }

      setNotice({
        type: failedUrls.length > 0 ? "warn" : "success",
        title: "Developed!",
        text: `${filename} (${formatBytes(result.size)}) is downloading.${rollsText}`,
        failedUrls,
      });
    } catch (error) {
      if (error.code === "QUOTA_EXHAUSTED" || error.code === "TOO_MANY_IMAGES") {
        // Merge, so storage details from /api/me are kept.
        if (error.data?.account) setAccount((a) => ({ ...a, ...error.data.account }));
        setPaywall(
          error.code === "QUOTA_EXHAUSTED" ? "exhausted" : "too-many"
        );
        return;
      }

      setNotice({
        type: "error",
        title: "Conversion failed",
        text: error.message,
      });
    } finally {
      setPhase("idle");
    }
  };

  const stack = files.slice(-3);

  return (
    <div className="app">
      <div className="grain" aria-hidden="true" />

      {account?.campaign && !account.admin && (
        <div className="sale-banner">
          {Icon.megaphone}
          <span>
            <strong>{account.campaign.banner || account.campaign.name}</strong>
            {" · "}
            {account.campaign.discountPercent}% off Pro
            {account.campaign.endsAt &&
              ` until ${formatDate(account.campaign.endsAt, { day: "numeric", month: "short" })}`}
          </span>
          {account.plan !== "pro" && (
            <button
              type="button"
              onClick={() => (account.user ? setBillingOpen(true) : setAuth({ mode: "register", intent: "upgrade" }))}
            >
              Get the deal
            </button>
          )}
        </div>
      )}

      <ExpiryBanner account={account} onRenew={() => setBillingOpen(true)} />

      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">{Icon.aperture}</span>
          <div>
            <h1>Image Converter Pro</h1>
            <p>Convert · Compress · Download · Optimize</p>
          </div>
        </div>

        <div className="topbar-actions">
          <RollMeter
            account={account}
            onUpgrade={() =>
              account.admin
                ? null
                : account.plan === "pro" || pendingReview
                ? setBillingOpen(true)
                : setPaywall(outOfFilm ? "exhausted" : "upgrade")
            }
          />

          <AccountMenu
            account={account}
            onSignIn={() => setAuth({ mode: "login" })}
            onBilling={() => setBillingOpen(true)}
            onInvite={() => setInviteOpen(true)}
            onSignOut={signOut}
          />

          <button
            className="icon-btn"
            onClick={() =>
              setTheme(theme === "dark" ? "light" : "dark")
            }
            aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
            title="Toggle theme"
          >
            {theme === "dark" ? Icon.sun : Icon.moon}
          </button>
        </div>
      </header>

      <main className="layout">
        <section className="workspace">
          <div
            className={`dropzone ${dragging ? "is-dragging" : ""} ${files.length ? "has-files" : ""}`}
            onClick={() => fileInput.current.click()}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                fileInput.current.click();
              }
            }}
            role="button"
            tabIndex={0}
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              addFiles(e.dataTransfer.files);
            }}
          >
            <input
              ref={fileInput}
              type="file"
              accept={ACCEPT}
              multiple
              hidden
              onChange={(e) => {
                addFiles(e.target.files);
                e.target.value = "";
              }}
            />

            <div className="drop-copy">
              <span className="eyebrow">Step 01 · Load the film</span>
              <h2>
                {dragging
                  ? "Let go to add them"
                  : "Drop your images here"}
              </h2>
              <p>
                JPG, PNG, WEBP or AVIF. Add as many as you like,
                or <u>browse your computer</u>.
              </p>
            </div>

            <div className="drop-stack" aria-hidden="true">
              {stack.length === 0 ? (
                <div className="drop-empty">{Icon.upload}</div>
              ) : (
                stack.map((f, i) => (
                  <div
                    key={f.id}
                    className="stack-print"
                    style={{
                      "--r": `${(i - (stack.length - 1) / 2) * 9}deg`,
                      "--x": `${(i - (stack.length - 1) / 2) * 34}px`,
                    }}
                  >
                    <img src={f.preview} alt="" />
                  </div>
                ))
              )}
            </div>
          </div>

          <div className="panel">
            <div className="panel-head">
              <span className="panel-icon">{Icon.link}</span>
              <div>
                <h3>Pull from the web</h3>
                <p>One image URL per line</p>
              </div>
              {urlLines.length > 0 && (
                <span className="pill">
                  {validUrls.length} link{validUrls.length === 1 ? "" : "s"}
                  {invalidCount > 0 && (
                    <em> · {invalidCount} invalid</em>
                  )}
                </span>
              )}
            </div>

            <textarea
              value={imageUrls}
              onChange={(e) => setImageUrls(e.target.value)}
              spellCheck={false}
              placeholder={`https://example.com/image1.jpg
https://example.com/image2.png
https://example.com/image3.webp`}
            />
          </div>

          <div className="panel">
            <div className="panel-head">
              <span className="panel-icon">{Icon.aperture}</span>
              <div>
                <h3>Contact sheet</h3>
                <p>
                  {files.length === 0
                    ? "Your uploaded images appear here"
                    : `${files.length} image${files.length === 1 ? "" : "s"} · ${formatBytes(totalBytes)}`}
                </p>
              </div>
              {files.length > 0 && (
                <button className="text-btn" onClick={clearFiles}>
                  Clear all
                </button>
              )}
            </div>

            {overLimit && (
              <div className="roll-banner">
                <span className="roll-banner-icon">{Icon.film}</span>
                <p>
                  <strong>A free roll holds {freeLimit} exposures.</strong>{" "}
                  You&apos;ve loaded {sourceCount}
                  {validUrls.length > 0 ? " (including URLs)" : ""}, so{" "}
                  {sourceCount - freeLimit} won&apos;t fit.
                </p>
                <button onClick={() => setPaywall("too-many")}>
                  Go Pro
                </button>
              </div>
            )}

            {files.length === 0 ? (
              <div className="sheet-empty">
                {Array.from({ length: 4 }).map((_, i) => (
                  <div key={i} className="frame-ghost" />
                ))}
              </div>
            ) : (
              <div className="sheet">
                {files.map((f, i) => (
                  <figure
                    key={f.id}
                    className={`print ${isFree && i >= freeLimit ? "is-locked" : ""}`}
                    style={{ "--tilt": `${((i * 37) % 7) - 3}deg` }}
                  >
                    <div className="print-photo">
                      <img src={f.preview} alt={f.file.name} />
                      {isFree && i >= freeLimit && (
                        <button
                          className="print-lock"
                          onClick={() => setPaywall("too-many")}
                          aria-label="Unlock with Pro"
                        >
                          {Icon.lock}
                          <span>Pro frame</span>
                        </button>
                      )}
                    </div>
                    <figcaption>
                      <span className="print-name" title={f.file.name}>
                        {f.file.name}
                      </span>
                      <span className="print-size">
                        {formatBytes(f.file.size)}
                      </span>
                    </figcaption>
                    <button
                      className="print-remove"
                      onClick={() => removeFile(f.id)}
                      aria-label={`Remove ${f.file.name}`}
                    >
                      {Icon.x}
                    </button>
                  </figure>
                ))}
              </div>
            )}
          </div>
        </section>

        <aside className="recipe">
          <div className="recipe-card">
            <span className="eyebrow">Step 02 · The recipe</span>

            <div className="field">
              <label>Output formats</label>
              <div className="format-grid">
                {FORMATS.map(({ id, note }) => {
                  const active = selectedFormats.includes(id);

                  return (
                    <button
                      key={id}
                      className={`format-tile ${active ? "is-active" : ""}`}
                      onClick={() => toggleFormat(id)}
                      aria-pressed={active}
                    >
                      <span className="format-check">{Icon.check}</span>
                      <strong>.{id.toLowerCase()}</strong>
                      <small>{note}</small>
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="field">
              <label htmlFor="target-size">Target size per image</label>
              <div className="size-input">
                <input
                  id="target-size"
                  type="number"
                  min="1"
                  value={targetSize}
                  onChange={(e) => setTargetSize(e.target.value)}
                />
                <div className="segmented" role="group" aria-label="Unit">
                  {["KB", "MB"].map((unit) => (
                    <button
                      key={unit}
                      className={sizeUnit === unit ? "is-active" : ""}
                      onClick={() => setSizeUnit(unit)}
                      aria-pressed={sizeUnit === unit}
                    >
                      {unit}
                    </button>
                  ))}
                </div>
              </div>
              <div className="presets">
                {PRESETS.map(({ size, unit }) => {
                  const active =
                    Number(targetSize) === size && sizeUnit === unit;

                  return (
                    <button
                      key={`${size}${unit}`}
                      className={active ? "is-active" : ""}
                      onClick={() => {
                        setTargetSize(size);
                        setSizeUnit(unit);
                      }}
                    >
                      {size} {unit}
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="equation">
              <div>
                <strong>{sourceCount}</strong>
                <span>sources</span>
              </div>
              <i>×</i>
              <div>
                <strong>{selectedFormats.length}</strong>
                <span>formats</span>
              </div>
              <i>=</i>
              <div className="equation-result">
                <strong>{outputCount}</strong>
                <span>files out</span>
              </div>
            </div>

            <button
              className={`develop-btn ${busy ? "is-busy" : ""}`}
              onClick={() => convertImages()}
              disabled={busy}
              style={{ "--p": phase === "converting" ? 1 : progress }}
            >
              <span className="develop-fill" aria-hidden="true" />
              <span className="develop-label">
                {phase === "uploading" &&
                  `Uploading ${Math.round(progress * 100)}%`}
                {phase === "converting" && "Developing…"}
                {phase === "idle" && outOfFilm && (
                  <>{Icon.lock} Get more film</>
                )}
                {phase === "idle" && !outOfFilm && (
                  <>
                    {overLimit && Icon.lock}
                    Develop {outputCount > 0 ? outputCount : ""} image
                    {outputCount === 1 ? "" : "s"} {Icon.arrow}
                  </>
                )}
              </span>
            </button>

            <p className="hint">
              {isFree && !outOfFilm
                ? `Uses 1 of your ${account.usesLeft} free roll${account.usesLeft === 1 ? "" : "s"} · up to ${freeLimit} images`
                : outputCount > 1
                  ? "Multiple results download as a single .zip"
                  : "Your result downloads automatically"}
            </p>

            {notice && (
              <div className={`notice notice-${notice.type}`} role="status">
                <span className="notice-icon">
                  {notice.type === "error" ? Icon.alert : Icon.check}
                </span>
                <div>
                  <strong>{notice.title}</strong>
                  <p>{notice.text}</p>
                  {notice.failedUrls?.length > 0 && (
                    <>
                      <p>These URLs couldn&apos;t be downloaded:</p>
                      <ul>
                        {notice.failedUrls.map((url) => (
                          <li key={url}>{url}</li>
                        ))}
                      </ul>
                    </>
                  )}
                </div>
                <button
                  className="notice-close"
                  onClick={() => setNotice(null)}
                  aria-label="Dismiss"
                >
                  {Icon.x}
                </button>
              </div>
            )}
          </div>
        </aside>
      </main>

      <footer className="footer">
        Images are processed on the server and never stored.
      </footer>

      {paywall && account && (
        <Paywall
          reason={paywall}
          account={account}
          imageCount={sourceCount}
          previews={files.map((f) => f.preview)}
          onClose={closePaywall}
          onUpgrade={startUpgrade}
          onDevelopFirst={() => convertImages(freeLimit)}
        />
      )}

      {auth && (
        <AuthModal
          initialMode={auth.mode}
          intent={auth.intent}
          reason={auth.reason}
          onClose={closeAuth}
          onAuthed={handleAuthed}
        />
      )}

      {inviteOpen && account?.user && <ReferralModal onClose={closeInvite} />}

      {billingOpen && account?.user && (
        <BillingModal
          account={account}
          onClose={closeBilling}
          onSubmitted={refreshAccount}
        />
      )}
    </div>
  );
}
