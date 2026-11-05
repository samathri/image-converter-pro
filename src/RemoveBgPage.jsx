import { useRef, useState } from "react";
import { Icon } from "./icons.jsx";
import { makeZip } from "./zip.js";
import ImageViewer from "./ImageViewer.jsx";

const ACCEPT = ".jpg,.jpeg,.png,.webp,.avif";

const BACKGROUNDS = [
  { id: "transparent", label: "Transparent", color: null },
  { id: "white", label: "White", color: "#ffffff" },
  { id: "black", label: "Black", color: "#000000" },
  { id: "custom", label: "Colour", color: null },
];

let nextId = 0;

// ---------- The AI runs in a Web Worker, shared by every visit to this page ----------

let worker;
const pending = new Map();
const listeners = new Set();

function getWorker() {
  if (!worker) {
    worker = new Worker(new URL("./bgWorker.js", import.meta.url), { type: "module" });
    worker.onmessage = ({ data }) => {
      if (data.type === "loading" || data.type === "ready") {
        listeners.forEach((fn) => fn(data));
        return;
      }

      const job = pending.get(data.id);

      pending.delete(data.id);
      if (data.type === "done") job?.resolve(data.blob);
      else job?.reject(new Error(data.message));
    };
  }

  return worker;
}

function removeBackground(id, blob) {
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    getWorker().postMessage({ id, blob });
  });
}

// ---------- Helpers ----------

const baseName = (name) => name.replace(/\.[^.]+$/, "") || "image";

/** The cut-out as a file: PNG with transparency, or JPEG on a solid colour. */
async function finalFile(item, color) {
  if (!color) return new File([item.result], `${baseName(item.file.name)}-no-bg.png`, { type: "image/png" });

  const bitmap = await createImageBitmap(item.result);
  const canvas = document.createElement("canvas");

  canvas.width = bitmap.width;
  canvas.height = bitmap.height;

  const ctx = canvas.getContext("2d");

  ctx.fillStyle = color;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();

  const blob = await new Promise((r) => canvas.toBlob(r, "image/jpeg", 0.92));

  return new File([blob], `${baseName(item.file.name)}-no-bg.jpg`, { type: "image/jpeg" });
}

function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");

  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const formatMb = (bytes) => `${(bytes / 1024 / 1024).toFixed(0)} MB`;

/** Before/after: drag the handle to compare the original with the cut-out. */
function Compare({ item, background }) {
  const [split, setSplit] = useState(50);

  return (
    <div className="bg-compare is-checker" style={background ? { background } : undefined}>
      <img src={item.resultUrl} alt={`${item.file.name} without background`} />
      <img
        className="bg-compare-before"
        src={item.preview}
        alt=""
        style={{ clipPath: `inset(0 ${100 - split}% 0 0)` }}
      />
      <span className="bg-compare-line" style={{ left: `${split}%` }} aria-hidden="true" />
      <input
        type="range"
        min="0"
        max="100"
        value={split}
        onChange={(e) => setSplit(Number(e.target.value))}
        aria-label="Compare before and after"
      />
    </div>
  );
}

export default function RemoveBgPage({ items, setItems, account, onLocked, onSendToConverter }) {
  const [running, setRunning] = useState(false);
  const [model, setModel] = useState(null); // { loaded, total } while the AI downloads
  const [background, setBackground] = useState("transparent");
  const [customColor, setCustomColor] = useState("#f4efe6");
  const [dragging, setDragging] = useState(false);
  const [viewing, setViewing] = useState(null);
  const [error, setError] = useState("");
  const fileInput = useRef(null);

  const pro = account?.plan === "pro";
  const done = items.filter((i) => i.status === "done");
  const todo = items.filter((i) => i.status !== "done" && i.status !== "working");
  const color = background === "custom" ? customColor : BACKGROUNDS.find((b) => b.id === background)?.color;
  const stack = items.slice(-3);

  const update = (id, patch) => setItems((current) => current.map((i) => (i.id === id ? { ...i, ...patch } : i)));

  const addFiles = (fileList) => {
    const images = Array.from(fileList)
      .filter((file) => /\.(jpe?g|png|webp|avif)$/i.test(file.name))
      .map((file) => ({ id: nextId++, file, preview: URL.createObjectURL(file) }));

    if (images.length > 0) {
      setItems((current) => [...current, ...images]);
      setError("");
    }
  };

  const removeItem = (id) => {
    const target = items.find((i) => i.id === id);

    if (target) {
      URL.revokeObjectURL(target.preview);
      if (target.resultUrl) URL.revokeObjectURL(target.resultUrl);
    }
    setItems(items.filter((i) => i.id !== id));
  };

  const clearAll = () => {
    items.forEach((i) => {
      URL.revokeObjectURL(i.preview);
      if (i.resultUrl) URL.revokeObjectURL(i.resultUrl);
    });
    setItems([]);
  };

  const run = async () => {
    if (!pro) {
      onLocked();
      return;
    }

    if (todo.length === 0) return;

    setRunning(true);
    setError("");

    // Download progress of the AI model (first time only).
    const onModel = (data) => setModel(data.type === "ready" ? null : data);

    listeners.add(onModel);

    for (const item of todo) {
      update(item.id, { status: "working", error: "" });

      try {
        const result = await removeBackground(item.id, item.file);

        update(item.id, { status: "done", result, resultUrl: URL.createObjectURL(result) });
      } catch (err) {
        update(item.id, { status: "error", error: err.message });

        // If the model couldn't load, the rest would fail too.
        if (/fetch|network|load/i.test(err.message)) {
          setError("Couldn't download the AI model. Check your connection and try again.");
          break;
        }
      }
    }

    listeners.delete(onModel);
    setModel(null);
    setRunning(false);
  };

  const download = async (item) => {
    const file = await finalFile(item, color);

    saveBlob(file, file.name);
  };

  const downloadAll = async () => {
    const files = await Promise.all(done.map((item) => finalFile(item, color)));
    const used = new Set();

    const entries = files.map((file) => {
      let name = file.name;

      for (let n = 2; used.has(name); n++) name = file.name.replace(/(\.[^.]+)$/, `-${n}$1`);
      used.add(name);
      return { name, data: file };
    });

    saveBlob(await makeZip(entries), "no-background.zip");
  };

  const sendToConverter = async () => {
    const files = await Promise.all(done.map((item) => finalFile(item, color)));

    onSendToConverter(files.map((file) => ({ file })));
  };

  const buttonLabel = running
    ? model
      ? `Downloading AI ${formatMb(model.loaded)} / ${formatMb(model.total)}`
      : "Removing backgrounds…"
    : !pro
      ? "Unlock with Pro"
      : todo.length > 0 && done.length > 0
        ? `Remove ${todo.length} more`
        : `Remove background${items.length === 1 ? "" : "s"}`;

  return (
    <main className="layout bg-page">
      <section className="workspace">
        <div
          className={`dropzone ${dragging ? "is-dragging" : ""} ${items.length ? "has-files" : ""}`}
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
            <span className="eyebrow">Step 01 · Add your photos</span>
            <h2>{dragging ? "Let go to add them" : "Remove backgrounds"}</h2>
            <p>
              AI cuts out the subject and removes everything behind it. It runs in your browser, so your
              photos are never uploaded. <u>Browse your computer</u> or drop images here.
            </p>
          </div>

          <div className="drop-stack" aria-hidden="true">
            {stack.length === 0 ? (
              <div className="drop-empty">{Icon.cutout}</div>
            ) : (
              stack.map((item, i) => (
                <div
                  key={item.id}
                  className="stack-print"
                  style={{
                    "--r": `${(i - (stack.length - 1) / 2) * 9}deg`,
                    "--x": `${(i - (stack.length - 1) / 2) * 34}px`,
                  }}
                >
                  <img src={item.resultUrl || item.preview} alt="" />
                </div>
              ))
            )}
          </div>
        </div>

        <div className="panel">
          <div className="panel-head">
            <span className="panel-icon">{Icon.cutout}</span>
            <div>
              <h3>Results</h3>
              <p>
                {items.length === 0
                  ? "Your photos appear here. Drag the slider to compare before and after."
                  : `${items.length} photo${items.length === 1 ? "" : "s"} · ${done.length} done`}
              </p>
            </div>
            {items.length > 0 && !running && (
              <button className="text-btn" onClick={clearAll}>
                Clear all
              </button>
            )}
          </div>

          {error && <p className="form-error">{error}</p>}

          {items.length === 0 ? (
            <div className="bg-empty">
              <div className="bg-empty-demo is-checker" aria-hidden="true">
                <span>{Icon.cutout}</span>
              </div>
              <p>Works best on photos with a clear subject: people, pets, products.</p>
            </div>
          ) : (
            <div className="bg-grid">
              {items.map((item) => (
                <figure key={item.id} className={`bg-card is-${item.status || "new"}`}>
                  {item.status === "done" ? (
                    <Compare item={item} background={color} />
                  ) : (
                    <div className="bg-frame">
                      <img src={item.preview} alt={item.file.name} />
                      {item.status === "working" && (
                        <div className="bg-working">
                          <span className="create-spinner" aria-hidden="true">{Icon.aperture}</span>
                          <span>{model ? "Getting the AI ready…" : "Cutting out…"}</span>
                        </div>
                      )}
                    </div>
                  )}

                  <figcaption>
                    <p title={item.file.name}>{item.file.name}</p>
                    {item.status === "error" && <p className="create-error">{item.error}</p>}

                    <div className="create-actions">
                      {item.status === "done" && (
                        <>
                          <button type="button" className="is-main" onClick={() => download(item)}>
                            {Icon.download} Download
                          </button>
                          <button type="button" onClick={() => setViewing(item)}>
                            {Icon.zoomIn} Zoom
                          </button>
                        </>
                      )}
                      {!running && (
                        <button type="button" onClick={() => removeItem(item.id)} aria-label="Remove" title="Remove">
                          {Icon.x}
                        </button>
                      )}
                    </div>
                  </figcaption>
                </figure>
              ))}
            </div>
          )}
        </div>
      </section>

      <aside className="recipe">
        <div className="recipe-card">
          <span className="eyebrow">Step 02 · The background</span>

          <div className="field">
            <label>New background</label>
            <div className="bg-options" role="group" aria-label="New background">
              {BACKGROUNDS.map(({ id, label, color: swatch }) => (
                <button
                  key={id}
                  className={background === id ? "is-active" : ""}
                  onClick={() => setBackground(id)}
                  aria-pressed={background === id}
                >
                  <i
                    className={id === "transparent" ? "is-checker" : ""}
                    style={{ background: id === "custom" ? customColor : swatch || undefined }}
                    aria-hidden="true"
                  />
                  {label}
                </button>
              ))}
            </div>
            {background === "custom" && (
              <label className="bg-color">
                <input type="color" value={customColor} onChange={(e) => setCustomColor(e.target.value)} />
                <span>{customColor}</span>
              </label>
            )}
            <small className="form-hint">
              {color ? "Downloads as JPG on this colour." : "Downloads as PNG with a see-through background."}
            </small>
          </div>

          <div className="equation">
            <div>
              <strong>{items.length}</strong>
              <span>photos</span>
            </div>
            <i>→</i>
            <div className="equation-result">
              <strong>{done.length}</strong>
              <span>cut out</span>
            </div>
          </div>

          <button
            className={`develop-btn ${running ? "is-busy" : ""}`}
            onClick={run}
            disabled={running || !account || (pro && todo.length === 0)}
            style={{ "--p": model?.total ? model.loaded / model.total : 0 }}
          >
            <span className="develop-fill" aria-hidden="true" />
            <span className="develop-label">
              {!pro && !running && Icon.lock}
              {pro && !running && Icon.cutout}
              {buttonLabel}
              {pro && !running && Icon.arrow}
            </span>
          </button>

          <p className="hint">
            {!pro
              ? "A Pro feature. Everyone can look around; Pro removes the backgrounds."
              : "The first time, the AI (about 45 MB) downloads once. After that it's quick."}
          </p>

          {done.length > 0 && (
            <div className="names-use">
              <span className="eyebrow">Step 03 · Use them</span>
              <button type="button" className="names-action is-main" onClick={downloadAll}>
                {Icon.download} Download all
                <small>.zip · {color ? "JPG on your colour" : "transparent PNG"}</small>
              </button>
              <button type="button" className="names-action" onClick={sendToConverter}>
                {Icon.arrow} Convert &amp; compress them
                <small>Opens the converter (pick WEBP or PNG to keep transparency)</small>
              </button>
            </div>
          )}
        </div>
      </aside>

      {viewing && (
        <ImageViewer
          src={viewing.resultUrl}
          title={`${baseName(viewing.file.name)}-no-bg`}
          transparent={!color}
          background={color || undefined}
          onClose={() => setViewing(null)}
          actions={
            <button type="button" className="btn-primary" onClick={() => download(viewing)}>
              {Icon.download} Download
            </button>
          }
        />
      )}
    </main>
  );
}
