import { useState } from "react";
import { Icon } from "./icons.jsx";
import { fetchJson } from "./api.js";

const PREVIEW_SIZE = 768;
const AT_ONCE = 2;

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

const cleanName = (value) =>
  value.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/-+/g, "-").slice(0, 60);

function csvCell(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

function downloadCsv(rows) {
  const csv = ["file name,alt text", ...rows.map((r) => `${csvCell(r.name)},${csvCell(r.alt)}`)].join("\r\n");
  const url = URL.createObjectURL(new Blob(["﻿" + csv], { type: "text/csv" }));
  const link = document.createElement("a");

  link.href = url;
  link.download = "alt-text.csv";
  link.click();
  URL.revokeObjectURL(url);
}

export default function AltTextPanel({ files, setFiles, account, useNames, onUseNamesChange, onLocked }) {
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(null);

  const pro = account?.plan === "pro";
  const done = files.filter((f) => f.ai?.status === "done");
  const todo = files.filter((f) => f.ai?.status !== "done");

  const update = (id, ai) =>
    setFiles((current) => current.map((f) => (f.id === id ? { ...f, ai: { ...f.ai, ...ai } } : f)));

  const generate = async (targets) => {
    if (!pro) {
      onLocked();
      return;
    }

    setRunning(true);
    setError("");

    const queue = [...targets];
    let stopped = false;

    const worker = async () => {
      while (queue.length > 0 && !stopped) {
        const f = queue.shift();

        update(f.id, { status: "loading", error: "" });

        try {
          const result = await fetchJson("/api/ai/describe", {
            method: "POST",
            json: { image: await makePreview(f.file) },
          });

          update(f.id, { status: "done", name: result.name, alt: result.alt });
        } catch (err) {
          update(f.id, { status: "error", error: err.message || "Couldn't read this image." });

          // Limits and setup problems affect every image: stop the rest.
          if ([402, 429, 503].includes(err.status)) {
            stopped = true;
            setError(err.message);
          }
        }
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

  const rows = done.map((f) => ({ name: f.ai.name, alt: f.ai.alt }));

  return (
    <div className="panel ai-panel">
      <div className="panel-head">
        <span className="panel-icon">{Icon.sparkle}</span>
        <div>
          <h3>
            Names &amp; alt text <span className="pro-tag">Pro</span>
          </h3>
          <p>
            {files.length === 0
              ? "Add images above, and AI writes a file name and alt text for each one."
              : "AI looks at each photo and writes a file name and alt text."}
          </p>
        </div>

        {todo.length > 0 || files.length === 0 ? (
          <button
            type="button"
            className="ai-generate"
            onClick={() => generate(todo)}
            // Free users can always click it to see what Pro offers.
            disabled={running || (pro && (account.ai === false || files.length === 0))}
          >
            {running ? (
              "Writing…"
            ) : (
              <>
                {pro ? Icon.sparkle : Icon.lock} Generate{done.length > 0 ? ` ${todo.length} more` : ""}
              </>
            )}
          </button>
        ) : (
          <button type="button" className="text-btn" onClick={() => generate(files)} disabled={running}>
            {Icon.refresh} Redo all
          </button>
        )}
      </div>

      {pro && account.ai === false && (
        <p className="ai-note">The AI isn&apos;t set up yet. Add GEMINI_API_KEY to the server settings.</p>
      )}
      {error && <p className="form-error">{error}</p>}

      {files.some((f) => f.ai?.status) && (
        <ul className="ai-list">
          {files.map((f) =>
            f.ai?.status ? (
              <li key={f.id} className={`ai-row is-${f.ai.status}`}>
                <img className="ai-thumb" src={f.preview} alt={f.ai.alt || ""} />

                {f.ai.status === "loading" && (
                  <div className="ai-fields">
                    <span className="ai-skeleton" />
                    <span className="ai-skeleton is-long" />
                  </div>
                )}

                {f.ai.status === "error" && (
                  <div className="ai-fields">
                    <p className="ai-error">{f.ai.error}</p>
                  </div>
                )}

                {f.ai.status === "done" && (
                  <div className="ai-fields">
                    <label className="ai-name">
                      <span className="sr-only">File name for {f.file.name}</span>
                      <input
                        value={f.ai.name}
                        onChange={(e) => update(f.id, { name: cleanName(e.target.value) })}
                        onBlur={(e) => update(f.id, { name: e.target.value.replace(/^-|-$/g, "") || "image" })}
                        spellCheck={false}
                      />
                    </label>
                    <label className="ai-alt">
                      <span className="sr-only">Alt text for {f.file.name}</span>
                      <textarea
                        value={f.ai.alt}
                        onChange={(e) => update(f.id, { alt: e.target.value.slice(0, 250) })}
                        rows={2}
                      />
                    </label>
                  </div>
                )}

                <div className="ai-actions">
                  {f.ai.status === "done" && (
                    <button
                      type="button"
                      onClick={() => copy(f.id, f.ai.alt)}
                      aria-label="Copy alt text"
                      title="Copy alt text"
                    >
                      {copied === f.id ? Icon.check : Icon.copy}
                    </button>
                  )}
                  {f.ai.status !== "loading" && (
                    <button
                      type="button"
                      onClick={() => generate([f])}
                      disabled={running}
                      aria-label="Write again"
                      title="Write again"
                    >
                      {Icon.refresh}
                    </button>
                  )}
                </div>
              </li>
            ) : null
          )}
        </ul>
      )}

      {done.length > 0 && (
        <div className="ai-foot">
          <label className="ai-toggle">
            <input type="checkbox" checked={useNames} onChange={(e) => onUseNamesChange(e.target.checked)} />
            Use these names for the downloaded files
          </label>
          <div className="ai-foot-actions">
            <button
              type="button"
              className="text-btn"
              onClick={() => copy("all", rows.map((r) => `${r.name}: ${r.alt}`).join("\n"))}
            >
              {copied === "all" ? Icon.check : Icon.copy} Copy all
            </button>
            <button type="button" className="text-btn" onClick={() => downloadCsv(rows)}>
              {Icon.download} CSV
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
