import Modal from "./Modal.jsx";
import { Icon } from "./icons.jsx";
import { formatMoney } from "./api.js";
import "./Paywall.css";

const PLACEHOLDER_FRAMES = [
  ["#ff7a45", "#7c3aed"],
  ["#0ea5e9", "#22c55e"],
  ["#1e293b", "#f59e0b"],
  ["#f472b6", "#fde68a"],
  ["#14532d", "#a3e635"],
  ["#6366f1", "#ec4899"],
];

function getCopy(reason, account, imageCount) {
  switch (reason) {
    case "exhausted":
      return {
        eyebrow: "Out of film",
        title: `You've developed all ${account.freeUses} free rolls`,
        text: "The free version is now locked. Go Pro to keep converting with no limits.",
      };

    case "too-many":
      return {
        eyebrow: "This roll is full",
        title: `${imageCount} exposures won't fit on a free roll`,
        text: `Free rolls hold ${account.maxImages} images. Go Pro to develop up to ${account.proMaxImages} at once.`,
      };

    default:
      return {
        eyebrow: "Pro darkroom",
        title: "Unlimited film, every month",
        text: "Convert as often as you like, with bigger batches.",
      };
  }
}

export default function Paywall({
  reason,
  account,
  imageCount,
  previews,
  onClose,
  onUpgrade,
  onDevelopFirst,
}) {
  const copy = getCopy(reason, account, imageCount);
  // During a sale, show the reduced monthly price next to the normal one.
  const salePercent = account.campaign?.discountPercent || 0;
  const listPrice = formatMoney(account.price, account.currency);
  const price = formatMoney(account.price * (1 - salePercent / 100), account.currency);
  const freeMax = account.maxImages;
  const pending = account.latestPayment?.status === "pending";
  const signedIn = Boolean(account.user);

  const features = [
    "Unlimited conversions",
    `Up to ${account.proMaxImages} images per batch`,
    "AVIF, WEBP, JPEG and PNG output",
    "Pay by bank transfer, no card needed",
  ];

  // Fill the strip with the user's own photos when we have them.
  const frameCount = Math.max(8, Math.min(previews.length, 12));
  const frames = Array.from({ length: frameCount }, (_, i) =>
    previews.length > 0
      ? { src: previews[i % previews.length] }
      : { colors: PLACEHOLDER_FRAMES[i % PLACEHOLDER_FRAMES.length] }
  );

  const showLocks = reason === "too-many";
  const canDevelopFirst = reason === "too-many" && account.usesLeft > 0;

  return (
    <Modal onClose={onClose} labelledBy="paywall-title" className="paywall">
      <div className="filmstrip" aria-hidden="true">
        <div className="filmstrip-track">
          {[...frames, ...frames].map((frame, i) => {
            const index = i % frames.length;
            const locked =
              (showLocks && index >= freeMax && index < Math.max(imageCount, freeMax + 1)) ||
              reason === "exhausted";

            return (
              <div key={i} className={`film-frame ${locked ? "is-locked" : ""}`}>
                {frame.src ? (
                  <img src={frame.src} alt="" />
                ) : (
                  <span
                    style={{
                      background: `linear-gradient(135deg, ${frame.colors[0]}, ${frame.colors[1]})`,
                    }}
                  />
                )}
                <em>{String(index + 1).padStart(2, "0")}</em>
                {locked && <b>{Icon.lock}</b>}
              </div>
            );
          })}
        </div>
      </div>

      <div className="paywall-body">
        <span className="eyebrow">{copy.eyebrow}</span>
        <h2 id="paywall-title">{copy.title}</h2>
        <p>{copy.text}</p>

        <div className="plan">
          <div className="plan-head">
            <div>
              <span className="plan-badge">{Icon.sparkle} Pro</span>
              <h3>Monthly plan</h3>
            </div>
            <div className="plan-price">
              {salePercent > 0 && <s className="plan-was">{listPrice}</s>}
              <strong>{price}</strong>
              <span>/ month</span>
            </div>
          </div>

          <ul>
            {features.map((feature) => (
              <li key={feature}>
                <span>{Icon.check}</span>
                {feature}
              </li>
            ))}
          </ul>
        </div>

        {pending ? (
          <button className="paywall-cta is-pending" onClick={onUpgrade}>
            {Icon.clock} Payment under review: check status
          </button>
        ) : (
          <button className="paywall-cta" onClick={onUpgrade}>
            {signedIn ? "Upgrade to Pro" : "Create an account to go Pro"}{" "}
            {Icon.arrow}
          </button>
        )}

        {canDevelopFirst && (
          <button className="paywall-secondary" onClick={onDevelopFirst}>
            Or develop just the first {freeMax} with a free roll (
            {account.usesLeft} left)
          </button>
        )}
      </div>
    </Modal>
  );
}
