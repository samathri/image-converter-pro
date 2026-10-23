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

  const link = data?.code ? `${window.location.origin}/?ref=${data.code}` : "";

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
      text: "Convert and compress images in seconds:",
      url: link,
    }).catch(() => {});

  const per = data?.friendsPerReward || 5;
  const progress = data ? (data.towardNext / per) * 100 : 0;
  const needed = data ? per - data.towardNext : per;

  return (
    <Modal onClose={onClose} labelledBy="referral-title" className="referral-modal">
      <div className="modal-body">
        <span className="eyebrow">Invite friends</span>
        <h2 id="referral-title">Share the darkroom</h2>

        {error && <p className="form-error">{error}</p>}
        {!data && !error && <p className="modal-lead">Loading…</p>}

        {data && !data.eligible && (
          <p className="modal-lead">Buy a Pro plan to get your invite link.</p>
        )}

        {data?.eligible && !data.enabled && (
          <p className="modal-lead">Invites are paused right now.</p>
        )}

        {data?.eligible && data.enabled && (
          <>
            <div className="reward-rule">
              <span>{Icon.gift}</span>
              <p>
                Get <strong>{data.rewardPercent}% off your next payment</strong> for every{" "}
                <strong>{per} friends</strong> who join with your link.
              </p>
            </div>

            <div className="reward-progress">
              <div className="reward-progress-head">
                <span>{data.towardNext} of {per} friends</span>
                <span>{needed} more for {data.rewardPercent}% off</span>
              </div>
              <div className="reward-bar" role="progressbar" aria-valuenow={data.towardNext} aria-valuemin={0} aria-valuemax={per}>
                <span style={{ width: `${progress}%` }} />
              </div>
            </div>

            {data.available > 0 && (
              <p className="reward-ready">
                {Icon.check} You have {data.available} reward{data.available === 1 ? "" : "s"} ready.
                {" "}{data.rewardPercent}% comes off your next payment automatically.
              </p>
            )}

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
              <div><strong>{data.earned}</strong><span>rewards earned</span></div>
              <div><strong>{data.available}</strong><span>ready to use</span></div>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
