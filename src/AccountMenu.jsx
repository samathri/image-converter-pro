import { useEffect, useRef, useState } from "react";
import { Icon } from "./icons.jsx";
import { formatDate } from "./api.js";

export default function AccountMenu({ account, onSignIn, onBilling, onInvite, onSignOut }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return;

    const close = (e) => {
      if (!ref.current?.contains(e.target)) setOpen(false);
    };
    const onKey = (e) => {
      if (e.key === "Escape") setOpen(false);
    };

    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", onKey);

    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (!account) return null;

  const user = account.user;

  if (!user) {
    return (
      <button className="signin-btn" onClick={onSignIn}>
        {Icon.user}
        <span>Sign in</span>
      </button>
    );
  }

  const pending = account.latestPayment?.status === "pending";
  const run = (fn) => () => {
    setOpen(false);
    fn();
  };

  return (
    <div className="account" ref={ref}>
      <button
        className={`avatar ${account.plan === "pro" ? "is-pro" : ""}`}
        onClick={() => setOpen(!open)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Account menu"
      >
        {user.name.trim().charAt(0).toUpperCase() || "?"}
      </button>

      {open && (
        <div className="account-menu" role="menu">
          <div className="account-head">
            <strong>{user.name}</strong>
            <span>{user.email}</span>
            <em className={`plan-line plan-${account.plan}`}>
              {account.admin
                ? "Admin · unlimited access"
                : account.plan === "pro"
                  ? `Pro until ${formatDate(account.proUntil, { day: "numeric", month: "short", year: "numeric" })}`
                  : pending
                    ? "Free · Pro payment under review"
                    : `Free · ${account.usesLeft} of ${account.freeUses} rolls left`}
            </em>
          </div>

          {/* Admins have unlimited access, so there's nothing to buy. */}
          {!account.admin && (
            <button role="menuitem" onClick={run(onBilling)}>
              {Icon.receipt}
              {account.plan === "pro" ? "Extend Pro & billing" : pending ? "Payment status" : "Upgrade to Pro"}
            </button>
          )}

          <button role="menuitem" onClick={run(onInvite)}>
            {Icon.gift}
            Invite friends
          </button>

          {user.role === "admin" && (
            <a role="menuitem" href="/admin">
              {Icon.shield}
              Admin dashboard
            </a>
          )}

          <button role="menuitem" onClick={run(onSignOut)}>
            {Icon.logout}
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}
