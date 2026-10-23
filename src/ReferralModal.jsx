import { useEffect, useState } from "react";
import Modal from "./Modal.jsx";
import { Icon } from "./icons.jsx";
import { fetchJson } from "./api.js";

export default function ReferralModal({ onClose }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    fetchJson("/api/promo/referral").then(setData).catch((err) => setError(err.message));
  }, []);

  const link = data ? `${window.location.origin}/?ref=${data.code}` : "";

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard unavailable; the link is still selectable
    }
  };

  const share = () =>
    navigator.share?.({
      title: "Image Converter Pro",
      text: "Convert and compress images in seconds. Get bonus free conversions with my invite:",
      url: link,
    }).catch(() => {});

  const r = data?.rewards;

  return (
    <Modal onClose={onClose} labelledBy="referral-title" className="referral-modal">
      <div className="modal-body">
        <span className="eyebrow">Invite friends</span>
        <h2 id="referral-title">Share the darkroom</h2>

        {error && <p className="form-error">{error}</p>}
        {!data && !error && <p className="modal-lead">Loading…</p>}

        {data && !data.enabled && <p className="modal-lead">The invite programme is paused right now.</p>}

        {data?.enabled && (
          <>
            <div className="reward-cards">
              {r.refereeBonusUses > 0 && (
                <div>
                  <span>{Icon.gift}</span>
                  <strong>+{r.refereeBonusUses} free</strong>
                  <small>conversions for your friend</small>
                </div>
              )}
              {r.refereeDiscountPercent > 0 && (
                <div>
                  <span>{Icon.tag}</span>
                  <strong>{r.refereeDiscountPercent}% off</strong>
                  <small>their first Pro plan</small>
                </div>
              )}
              {r.referrerBonusDays > 0 && (
                <div className="is-you">
                  <span>{Icon.sparkle}</span>
                  <strong>+{r.referrerBonusDays} days Pro</strong>
                  <small>for you when they upgrade</small>
                </div>
              )}
            </div>

            <div className="invite-link">
              <input value={link} readOnly onFocus={(e) => e.target.select()} aria-label="Your invite link" />
              <button type="button" className="btn-primary" onClick={copy}>
                {copied ? <>{Icon.check} Copied</> : <>{Icon.copy} Copy</>}
              </button>
            </div>

            {navigator.share && (
              <button type="button" className="btn-ghost share-btn" onClick={share}>
                Share…
              </button>
            )}

            <div className="referral-stats">
              <div><strong>{data.joined}</strong><span>friends joined</span></div>
              <div><strong>{data.rewarded}</strong><span>upgraded</span></div>
              <div><strong>{data.daysEarned}</strong><span>Pro days earned</span></div>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
