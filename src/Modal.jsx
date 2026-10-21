import { useEffect } from "react";
import { Icon } from "./icons.jsx";
import "./Modal.css";

// Shared dialog shell: backdrop, Escape to close, scroll lock.
export default function Modal({ onClose, labelledBy, className = "", children }) {
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") onClose();
    };

    document.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";

    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [onClose]);

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className={`modal ${className}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
      >
        <button className="modal-close" onClick={onClose} aria-label="Close">
          {Icon.x}
        </button>
        {children}
      </div>
    </div>
  );
}
