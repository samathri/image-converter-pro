import { useState } from "react";
import Modal from "./Modal.jsx";
import { Icon } from "./icons.jsx";
import { fetchJson } from "./api.js";

export default function AuthModal({ initialMode = "register", reason, onClose, onAuthed }) {
  const [mode, setMode] = useState(initialMode);
  const [form, setForm] = useState({ name: "", email: "", password: "" });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const isRegister = mode === "register";

  const update = (key) => (e) =>
    setForm((current) => ({ ...current, [key]: e.target.value }));

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError("");

    try {
      await fetchJson(`/api/auth/${isRegister ? "register" : "login"}`, {
        method: "POST",
        json: isRegister
          ? form
          : { email: form.email, password: form.password },
      });

      await onAuthed();
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  return (
    <Modal onClose={onClose} labelledBy="auth-title" className="auth-modal">
      <div className="auth-hero" aria-hidden="true">
        <span className="auth-badge">{Icon.aperture}</span>
      </div>

      <div className="modal-body">
        <span className="eyebrow">
          {isRegister ? "Join the darkroom" : "Welcome back"}
        </span>
        <h2 id="auth-title">
          {isRegister ? "Create your account" : "Sign in"}
        </h2>
        <p className="modal-lead">
          {reason ||
            (isRegister
              ? "You need an account to buy Pro. Your free rolls come with you."
              : "Sign in to manage your Pro plan.")}
        </p>

        <form className="form" onSubmit={submit}>
          {isRegister && (
            <label className="form-field">
              <span>Name</span>
              <input
                value={form.name}
                onChange={update("name")}
                autoComplete="name"
                required
                maxLength={80}
              />
            </label>
          )}

          <label className="form-field">
            <span>Email</span>
            <input
              type="email"
              value={form.email}
              onChange={update("email")}
              autoComplete="email"
              required
            />
          </label>

          <label className="form-field">
            <span>Password</span>
            <input
              type="password"
              value={form.password}
              onChange={update("password")}
              autoComplete={isRegister ? "new-password" : "current-password"}
              minLength={isRegister ? 8 : undefined}
              required
            />
            {isRegister && (
              <small className="form-hint">At least 8 characters.</small>
            )}
          </label>

          {error && <p className="form-error">{error}</p>}

          <button className="btn-primary" disabled={busy}>
            {busy
              ? "Please wait…"
              : isRegister
                ? <>Create account {Icon.arrow}</>
                : <>Sign in {Icon.arrow}</>}
          </button>
        </form>

        <p className="auth-switch">
          {isRegister ? "Already have an account? " : "New here? "}
          <button
            type="button"
            className="link-btn"
            onClick={() => {
              setMode(isRegister ? "login" : "register");
              setError("");
            }}
          >
            {isRegister ? "Sign in" : "Create an account"}
          </button>
        </p>
      </div>
    </Modal>
  );
}
