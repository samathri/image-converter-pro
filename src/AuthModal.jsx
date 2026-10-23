import { useEffect, useState } from "react";
import Modal from "./Modal.jsx";
import { Icon } from "./icons.jsx";
import { fetchJson } from "./api.js";

/** Password field with a show/hide button. */
export function PasswordInput({ value, onChange, autoComplete, minLength, autoFocus }) {
  const [visible, setVisible] = useState(false);

  return (
    <div className="password-input">
      <input
        type={visible ? "text" : "password"}
        value={value}
        onChange={onChange}
        autoComplete={autoComplete}
        minLength={minLength}
        autoFocus={autoFocus}
        required
      />
      <button
        type="button"
        className="password-toggle"
        onClick={() => setVisible(!visible)}
        aria-label={visible ? "Hide password" : "Show password"}
        title={visible ? "Hide password" : "Show password"}
      >
        {visible ? Icon.eyeOff : Icon.eye}
      </button>
    </div>
  );
}

function CodeInput({ value, onChange }) {
  return (
    <input
      className="code-input"
      value={value}
      onChange={(e) => onChange(e.target.value.replace(/\D/g, "").slice(0, 6))}
      inputMode="numeric"
      autoComplete="one-time-code"
      placeholder="••••••"
      maxLength={6}
      autoFocus
      required
    />
  );
}

const TITLES = {
  login: ["Welcome back", "Sign in"],
  register: ["Join the darkroom", "Create your account"],
  verify: ["Check your email", "Enter your code"],
  forgot: ["Forgot password", "Reset your password"],
  reset: ["Check your email", "Choose a new password"],
};

const SUBMIT_LABEL = {
  login: "Sign in",
  register: "Continue",
  verify: "Verify & create account",
  forgot: "Send reset code",
  reset: "Save new password",
};

export default function AuthModal({ initialMode = "register", reason, intent, onClose, onAuthed }) {
  const [mode, setMode] = useState(initialMode);
  const [form, setForm] = useState({ name: "", email: "", password: "", code: "" });
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");
  const [busy, setBusy] = useState(false);
  const [providers, setProviders] = useState({ google: false });

  useEffect(() => {
    fetchJson("/api/auth/providers").then(setProviders).catch(() => {});
  }, []);

  const update = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

  const go = (next) => {
    setMode(next);
    setError("");
    setInfo("");
    setForm((f) => ({ ...f, code: "", password: next === "reset" ? "" : f.password }));
  };

  const run = async (fn) => {
    setBusy(true);
    setError("");

    try {
      await fn();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const submit = (e) => {
    e.preventDefault();

    run(async () => {
      if (mode === "login") {
        await fetchJson("/api/auth/login", { method: "POST", json: { email: form.email, password: form.password } });
        await onAuthed();
      } else if (mode === "register") {
        await fetchJson("/api/auth/register", { method: "POST", json: form });
        go("verify");
      } else if (mode === "verify") {
        await fetchJson("/api/auth/register/verify", { method: "POST", json: { email: form.email, code: form.code } });
        await onAuthed({ created: true });
      } else if (mode === "forgot") {
        await fetchJson("/api/auth/password/forgot", { method: "POST", json: { email: form.email } });
        go("reset");
      } else if (mode === "reset") {
        await fetchJson("/api/auth/password/reset", {
          method: "POST",
          json: { email: form.email, code: form.code, password: form.password },
        });
        await onAuthed();
      }
    });
  };

  const resend = () =>
    run(async () => {
      await fetchJson(mode === "verify" ? "/api/auth/register" : "/api/auth/password/forgot", {
        method: "POST",
        json: form,
      });
      setInfo("We sent a new code.");
    });

  const [eyebrow, title] = TITLES[mode];
  const showSocial = (mode === "login" || mode === "register") && providers.google;
  const codeStep = mode === "verify" || mode === "reset";

  return (
    <Modal onClose={onClose} labelledBy="auth-title" className="auth-modal">
      <div className="auth-hero" aria-hidden="true">
        <span className="auth-badge">{codeStep ? Icon.mail : Icon.aperture}</span>
      </div>

      <div className="modal-body">
        <span className="eyebrow">{eyebrow}</span>
        <h2 id="auth-title">{title}</h2>
        {reason && !codeStep && <p className="modal-lead">{reason}</p>}
        {codeStep && (
          <p className="modal-lead">
            We sent a 6-digit code to <strong>{form.email}</strong>.
          </p>
        )}

        {showSocial && (
          <div className="social-buttons">
            {providers.google && (
              <a className="social-btn" href={`/api/auth/oauth/google${intent === "upgrade" ? "?next=upgrade" : ""}`}>
                {Icon.google} Continue with Google
              </a>
            )}
            <div className="divider"><span>or</span></div>
          </div>
        )}

        <form className="form" onSubmit={submit}>
          {mode === "register" && (
            <label className="form-field">
              <span>Name</span>
              <input value={form.name} onChange={update("name")} autoComplete="name" required maxLength={80} />
            </label>
          )}

          {(mode === "login" || mode === "register" || mode === "forgot") && (
            <label className="form-field">
              <span>Email</span>
              <input type="email" value={form.email} onChange={update("email")} autoComplete="email" required />
            </label>
          )}

          {codeStep && (
            <label className="form-field">
              <span>Code</span>
              <CodeInput value={form.code} onChange={(code) => setForm((f) => ({ ...f, code }))} />
            </label>
          )}

          {(mode === "login" || mode === "register" || mode === "reset") && (
            <div className="form-field">
              <span className="field-label-row">
                {mode === "reset" ? "New password" : "Password"}
                {mode === "login" && (
                  <button type="button" className="link-btn small" onClick={() => go("forgot")}>
                    Forgot password?
                  </button>
                )}
              </span>
              <PasswordInput
                value={form.password}
                onChange={update("password")}
                autoComplete={mode === "login" ? "current-password" : "new-password"}
                minLength={mode === "login" ? undefined : 8}
              />
              {mode !== "login" && <small className="form-hint">At least 8 characters.</small>}
            </div>
          )}

          {error && <p className="form-error">{error}</p>}
          {info && <p className="form-info">{info}</p>}

          <button className="btn-primary" disabled={busy}>
            {busy ? "Please wait…" : <>{SUBMIT_LABEL[mode]} {Icon.arrow}</>}
          </button>
        </form>

        <p className="auth-switch">
          {mode === "login" && (
            <>
              New here?{" "}
              <button type="button" className="link-btn" onClick={() => go("register")}>Create an account</button>
            </>
          )}
          {mode === "register" && (
            <>
              Already have an account?{" "}
              <button type="button" className="link-btn" onClick={() => go("login")}>Sign in</button>
            </>
          )}
          {codeStep && (
            <>
              Didn&apos;t get it?{" "}
              <button type="button" className="link-btn" onClick={resend} disabled={busy}>Send a new code</button>
              {" · "}
              <button type="button" className="link-btn" onClick={() => go(mode === "verify" ? "register" : "forgot")}>
                Change email
              </button>
            </>
          )}
          {mode === "forgot" && (
            <button type="button" className="link-btn" onClick={() => go("login")}>Back to sign in</button>
          )}
        </p>
      </div>
    </Modal>
  );
}
