import { useRef, useState } from "react";
import { Icon } from "./icons.jsx";
import { fetchJson } from "./api.js";
import { makeZip } from "./zip.js";

const PREVIEW_SIZE = 768;
const AT_ONCE = 2;
const ACCEPT = ".jpg,.jpeg,.png,.webp,.avif";

const FIELD_OPTIONS = [
  { id: "name", label: "File names", note: "e.g. red-bicycle.jpg" },
  { id: "alt", label: "Alt text", note: "For screen readers & SEO" },
];

let nextId = 0;

/** A small JPEG of the image (as a data URL): enough for the AI to see it, quick to send. */
async function makePreview(file) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, PREVIEW_SIZE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");

  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);

  const ctx = canvas.getContext("2d");

  // White behind transparent PNGs, so they don't turn black in the JPEG.
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();

  return canvas.toDataURL("image/jpeg", 0.82);
}

const extensionOf = (filename) => filename.match(/\.[^.]+$/)?.[0].toLowerCase() || "";

const cleanName = (value) =>
  value.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/-+/g, "-").slice(0, 60);

/** New file names (name + original extension), made unique within the batch. */
export function finalNames(items) {
  const used = new Set();

  return items.map((item) => {
    const ext = extensionOf(item.file.name);
    const base = item.name || item.file.name.replace(/\.[^.]+$/, "");
    let name = `${base}${ext}`;

    for (let n = 2; used.has(name); n++) name = `${base}-${n}${ext}`;
    used.add(name);
    return name;
  });
}

const csvCell = (value) => `"${String(value ?? "").replace(/"/g, '""')}"`;

function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");

  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function Example() {
  return (
    <div className="names-example" aria-label="Example result">
      <span className="eyebrow">Example</span>
      <div className="names-example-row">
        <div className="names-example-photo" aria-hidden="true">{Icon.aperture}</div>
        <div>
          <p className="names-example-before">IMG_2041.jpg</p>
          <p className="names-example-after">golden-retriever-running-on-beach.jpg</p>
          <p className="names-example-alt">“A golden retriever running along a sandy beach at sunset.”</p>
        </div>
      </div>
    </div>
  );
}

export default function NamesPage({ items, setItems, fields, setFields, account, onLocked, onSendToConverter }) {
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(null);
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef(null);

  const pro = account?.plan === "pro";
  const wantsName = fields.includes("name");
  const wantsAlt = fields.includes("alt");
  const written = items.filter((i) => i.status === "done");
  const todo = items.filter((i) => i.status !== "done" && i.status !== "loading");
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

    if (target) URL.revokeObjectURL(target.preview);
    setItems(items.filter((i) => i.id !== id));
  };

  const clearAll = () => {
    items.forEach((i) => URL.revokeObjectURL(i.preview));
    setItems([]);
  };

  const toggleField = (id) =>
    setFields((current) =>
      current.includes(id)
        ? current.length > 1
          ? current.filter((f) => f !== id)
          : current // keep at least one
        : FIELD_OPTIONS.map((o) => o.id).filter((f) => f === id || current.includes(f))
    );

  const generate = async (targets) => {
    if (!pro) {
      onLocked();
      return;
    }

    if (targets.length === 0) return;

    setRunning(true);
    setError("");
    setProgress({ done: 0, total: targets.length });

    const queue = [...targets];
    let stopped = false;

    const worker = async () => {
      while (queue.length > 0 && !stopped) {
        const item = queue.shift();

        update(item.id, { status: "loading", error: "" });

        try {
          const result = await fetchJson("/api/ai/describe", {
            method: "POST",
            json: { image: await makePreview(item.file), fields },
          });

          // Keep what was written before for fields not asked for this time.
          update(item.id, { status: "done", ...result });
        } catch (err) {
          update(item.id, { status: "error", error: err.message || "Couldn't read this image." });

          // Limits and setup problems affect every image: stop the rest.
          if ([402, 429, 503].includes(err.status)) {
            stopped = true;
            setError(err.message);
          }
        }

        setProgress((p) => ({ ...p, done: p.done + 1 }));
      }
    };

    await Promise.all(Array.from({ length: AT_ONCE }, worker));
    setRunning(false);
  };

  const copy = async (key, text) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(key);
      setTimeout(() => setCopied((c) => (c === key ? null : c)), 1500);
    } catch {
      // clipboard unavailable; the text can still be selected
    }
  };

  const names = finalNames(written);
  const hasNames = written.some((i) => i.name);
  const hasAlt = written.some((i) => i.alt);

  const downloadZip = async () => {
    const files = written.map((item, i) => ({ name: names[i], data: item.file }));

    if (hasAlt) {
      const csv = ["file,alt text", ...written.map((item, i) => `${csvCell(names[i])},${csvCell(item.alt)}`)];
      files.push({ name: "alt-text.csv", data: "﻿" + csv.join("\r\n") });
    }

    saveBlob(await makeZip(files), "renamed-images.zip");
  };

  const downloadCsv = () => {
    const rows = written.map((item, i) => [item.file.name, names[i], item.alt].map(csvCell).join(","));
    const csv = ["original,new name,alt text", ...rows].join("\r\n");

    saveBlob(new Blob(["﻿" + csv], { type: "text/csv" }), "names-and-alt-text.csv");
  };

  const copyAll = () =>
    copy(
      "all",
      written
        .map((item, i) => [hasNames && names[i], hasAlt && item.alt].filter(Boolean).join(": "))
        .join("\n")
    );

  const sendToConverter = () =>
    onSendToConverter(
      written.map((item, i) => ({
        file: new File([item.file], names[i], { type: item.file.type }),
        alt: item.alt,
        sourceId: item.sourceId,
      }))
    );

  const what = wantsName && wantsAlt ? "names & alt text" : wantsName ? "file names" : "alt text";
  const buttonLabel = running
    ? `Writing ${Math.min(progress.done + 1, progress.total)} of ${progress.total}…`
    : !pro
      ? "Unlock with Pro"
      : todo.length > 0 && written.length > 0
        ? `Write ${what} for ${todo.length} more`
        : `Write ${what}`;

  return (
    <main className="layout names-page">
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
            <h2>{dragging ? "Let go to add them" : "Name your images"}</h2>
            <p>
              AI writes a clear file name and alt text for each photo. Download them renamed,
              or convert them too. <u>Browse your computer</u> or drop images here.
            </p>
          </div>

          <div className="drop-stack" aria-hidden="true">
            {stack.length === 0 ? (
              <div className="drop-empty">{Icon.sparkle}</div>
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
                  <img src={item.preview} alt="" />
                </div>
              ))
            )}
          </div>
        </div>

        <div className="panel">
          <div className="panel-head">
            <span className="panel-icon">{Icon.sparkle}</span>
            <div>
              <h3>Results</h3>
              <p>
                {items.length === 0
                  ? "Your photos and their new names appear here"
                  : `${items.length} photo${items.length === 1 ? "" : "s"} · ${written.length} written`}
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
            <Example />
          ) : (
            <ul className="ai-list">
              {items.map((item) => (
                <li key={item.id} className={`ai-row is-${item.status || "new"}`}>
                  <img className="ai-thumb" src={item.preview} alt={item.alt || ""} />

                  <div className="ai-fields">
                    <span className="ai-original" title={item.file.name}>{item.file.name}</span>

                    {item.status === "loading" && (
                      <>
                        <span className="ai-skeleton" />
                        {wantsAlt && <span className="ai-skeleton is-long" />}
                      </>
                    )}

                    {item.status === "error" && <p className="ai-error">{item.error}</p>}

                    {item.status === "done" && item.name !== undefined && (
                      <label className="ai-name">
                        <span className="sr-only">New file name for {item.file.name}</span>
                        <input
                          value={item.name}
                          onChange={(e) => update(item.id, { name: cleanName(e.target.value) })}
                          onBlur={(e) => update(item.id, { name: e.target.value.replace(/^-|-$/g, "") || "image" })}
                          spellCheck={false}
                        />
                        <span className="ai-ext">{extensionOf(item.file.name)}</span>
                      </label>
                    )}

                    {item.status === "done" && item.alt !== undefined && (
                      <label className="ai-alt">
                        <span className="sr-only">Alt text for {item.file.name}</span>
                        <textarea
                          value={item.alt}
                          onChange={(e) => update(item.id, { alt: e.target.value.slice(0, 250) })}
                          rows={2}
                        />
                      </label>
                    )}

                    {!item.status && <span className="ai-waiting">Ready to write</span>}
                  </div>

                  <div className="ai-actions">
                    {item.status === "done" && item.name !== undefined && (
                      <button
                        type="button"
                        onClick={() => copy(`n${item.id}`, item.name + extensionOf(item.file.name))}
                        aria-label="Copy file name"
                        title="Copy file name"
                      >
                        {copied === `n${item.id}` ? Icon.check : Icon.copy}
                      </button>
                    )}
                    {item.status === "done" && item.alt !== undefined && (
                      <button
                        type="button"
                        onClick={() => copy(`a${item.id}`, item.alt)}
                        aria-label="Copy alt text"
                        title="Copy alt text"
                      >
                        {copied === `a${item.id}` ? Icon.check : Icon.copy}
                      </button>
                    )}
                    {(item.status === "done" || item.status === "error") && (
                      <button
                        type="button"
                        onClick={() => generate([item])}
                        disabled={running}
                        aria-label="Write again"
                        title="Write again"
                      >
                        {Icon.refresh}
                      </button>
                    )}
                    {!running && (
                      <button
                        type="button"
                        onClick={() => removeItem(item.id)}
                        aria-label={`Remove ${item.file.name}`}
                        title="Remove"
                      >
                        {Icon.x}
                      </button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      <aside className="recipe">
        <div className="recipe-card">
          <span className="eyebrow">Step 02 · What to write</span>

          <div className="field">
            <label>Choose one or both</label>
            <div className="format-grid names-options">
              {FIELD_OPTIONS.map(({ id, label, note }) => {
                const active = fields.includes(id);

                return (
                  <button
                    key={id}
                    className={`format-tile ${active ? "is-active" : ""}`}
                    onClick={() => toggleField(id)}
                    aria-pressed={active}
                  >
                    <span className="format-check">{Icon.check}</span>
                    <strong>{label}</strong>
                    <small>{note}</small>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="equation">
            <div>
              <strong>{items.length}</strong>
              <span>photos</span>
            </div>
            <i>×</i>
            <div>
              <strong>{fields.length}</strong>
              <span>{fields.length === 1 ? "field" : "fields"}</span>
            </div>
            <i>=</i>
            <div className="equation-result">
              <strong>{items.length * fields.length}</strong>
              <span>to write</span>
            </div>
          </div>

          <button
            className={`develop-btn ${running ? "is-busy" : ""}`}
            onClick={() => generate(todo.length > 0 ? todo : items)}
            disabled={running || (pro && (items.length === 0 || account?.ai === false))}
            style={{ "--p": progress.total ? progress.done / progress.total : 0 }}
          >
            <span className="develop-fill" aria-hidden="true" />
            <span className="develop-label">
              {!pro && !running && Icon.lock}
              {pro && !running && Icon.sparkle}
              {buttonLabel}
              {pro && !running && Icon.arrow}
            </span>
          </button>

          <p className="hint">
            {!pro
              ? "A Pro feature. Everyone can look around; Pro writes the names."
              : account?.ai === false
                ? "The AI isn't set up yet (GEMINI_API_KEY)."
                : written.length > 0 && todo.length === 0
                  ? "Click again to write them all again"
                  : "Only a small preview is sent, and nothing is stored"}
          </p>

          {written.length > 0 && (
            <div className="names-use">
              <span className="eyebrow">Step 03 · Use them</span>

              {hasNames && (
                <button type="button" className="names-action is-main" onClick={downloadZip}>
                  {Icon.download} Download renamed images
                  <small>Originals, no conversion · .zip{hasAlt ? " with alt-text.csv" : ""}</small>
                </button>
              )}
              <button type="button" className="names-action" onClick={sendToConverter}>
                {Icon.arrow} Convert &amp; compress {hasNames ? "with these names" : "them"}
                <small>Opens the converter{hasAlt ? "; the zip includes alt-text.csv" : ""}</small>
              </button>
              <div className="names-action-row">
                <button type="button" className="names-action" onClick={downloadCsv}>
                  {Icon.download} CSV
                </button>
                <button type="button" className="names-action" onClick={copyAll}>
                  {copied === "all" ? Icon.check : Icon.copy} Copy all
                </button>
              </div>
            </div>
          )}
        </div>
      </aside>
    </main>
  );
}
