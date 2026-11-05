import { useState } from "react";
import Modal from "./Modal.jsx";
import { Icon } from "./icons.jsx";

/**
 * Full-size look at an image before downloading it. Click the image (or the
 * button) to switch between "fit to screen" and actual size; at actual size
 * the image can be scrolled around.
 */
export default function ImageViewer({ src, title, transparent = false, background, onClose, actions }) {
  const [zoomed, setZoomed] = useState(false);
  const [size, setSize] = useState(null);

  return (
    <Modal onClose={onClose} labelledBy="viewer-title" className="viewer">
      <div className="viewer-head">
        <h2 id="viewer-title" title={title}>{title}</h2>
        {size && <span className="viewer-size">{size.w} × {size.h}</span>}
      </div>

      <div
        className={`viewer-stage ${zoomed ? "is-zoomed" : ""} ${transparent ? "is-checker" : ""}`}
        style={background ? { background } : undefined}
      >
        <img
          src={src}
          alt={title}
          onLoad={(e) => setSize({ w: e.target.naturalWidth, h: e.target.naturalHeight })}
          onClick={() => setZoomed(!zoomed)}
          title={zoomed ? "Fit to screen" : "Actual size"}
        />
      </div>

      <div className="viewer-actions">
        <button type="button" className="viewer-zoom" onClick={() => setZoomed(!zoomed)}>
          {zoomed ? Icon.zoomOut : Icon.zoomIn} {zoomed ? "Fit to screen" : "Zoom to 100%"}
        </button>
        <div className="viewer-buttons">{actions}</div>
      </div>
    </Modal>
  );
}
