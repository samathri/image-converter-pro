import { useRef, useState } from "react";
import { Icon } from "./icons.jsx";
import { apiFetch } from "./api.js";

const STYLES = [
  { id: "none", label: "No style", note: "Just your words" },
  { id: "photo", label: "Photo", note: "Realistic" },
  { id: "illustration", label: "Illustration", note: "Digital art" },
  { id: "3d", label: "3D render", note: "Soft studio light" },
  { id: "watercolor", label: "Watercolor", note: "Painted" },
  { id: "anime", label: "Anime", note: "Cel shaded" },
  { id: "flat", label: "Flat vector", note: "Simple shapes" },
  { id: "sketch", label: "Sketch", note: "Pencil" },
];

const SHAPES = [
  { id: "square", label: "Square", ratio: "1 / 1" },
  { id: "landscape", label: "Landscape", ratio: "1216 / 832" },
  { id: "portrait", label: "Portrait", ratio: "832 / 1216" },
  { id: "wide", label: "Wide", ratio: "1344 / 768" },
];

const KEYWORDS = [
  "golden hour",
  "studio lighting",
  "minimal",
  "pastel colours",
  "high detail",
  "cinematic",
  "top view",
  "bokeh background",
  "isometric",
  "neon glow",
];

const EXAMPLES = [
  "A cosy coffee shop on a rainy evening, warm lights in the windows",
  "White sneaker floating above a pastel background, product shot",
  "Tiny house on a floating island with waterfalls, clouds around it",
];

// Free Pollinations: one image every 45 seconds per person.
const FREE_WAIT = 45;
let nextFreeAt = 0; // survives switching pages

let nextId = 0;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function fileNameFor(item) {
  const words = item.prompt.toLowerCase().replace(/[^a-z0-9\s-]/g, "").split(/\s+/).filter(Boolean);
  const ext = item.blob?.type === "image/png" ? ".png" : item.blob?.type === "image/webp" ? ".webp" : ".jpg";

  return `${words.slice(0, 6).join("-") || "image"}-${item.seed}${ext}`;
}

function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");

  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export default function CreatePage({ items, setItems, settings, setSettings, account, onLocked, onSendToConverter, onSendToNames }) {
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");
  const [countdown, setCountdown] = useState(0);
  const stopRef = useRef(false);
  const promptRef = useRef(null);

  const pro = account?.plan === "pro";
  // Free Pollinations (no key): one image every 45 seconds.
  const freeTier = account?.imageFree !== false;
  const { prompt, style, shape, count, enhance } = settings;
  const set = (patch) => setSettings((s) => ({ ...s, ...patch }));

  const update = (id, patch) => setItems((current) => current.map((i) => (i.id === id ? { ...i, ...patch } : i)));

  // Waits (with a visible countdown) until a time has passed, unless stopped.
  const waitUntil = async (time) => {
    while (Date.now() < time && !stopRef.current) {
      setCountdown(Math.ceil((time - Date.now()) / 1000));
      await wait(250);
    }
    setCountdown(0);
  };

  const addKeyword = (word) => {
    const text = prompt.trim();

    if (text.toLowerCase().includes(word)) return;
    set({ prompt: text ? `${text.replace(/[,\s]+$/, "")}, ${word}` : word });
    promptRef.current?.focus();
  };

  // The free service asked for a break: try again after it.
  const pause = (seconds, item) => {
    nextFreeAt = Date.now() + (seconds + 1) * 1000;
    update(item.id, { status: "queued" });
  };

  /** Creates one image; returns { blob, seed }. */
  const createOne = async (item) => {
    let url = null; // free mode on Vercel: the image address, fetched by this browser
    let seed = item.seed;

    for (let attempt = 0; attempt < 5 && !stopRef.current; attempt++) {
      await waitUntil(nextFreeAt);
      if (stopRef.current) break;
      update(item.id, { status: "loading" });

      if (!url) {
        const response = await apiFetch("/api/ai/image", {
          method: "POST",
          json: { prompt: item.prompt, style: item.style, shape: item.shape, enhance: item.enhance, seed: item.seed },
        });
        const isJson = response.headers.get("content-type")?.includes("application/json");
        const data = isJson ? await response.json().catch(() => ({})) : null;

        if (response.status === 429 && data?.retryAfter) {
          pause(data.retryAfter, item);
          continue;
        }

        if (!response.ok) {
          throw Object.assign(new Error(data?.message || "Couldn't create the image."), { status: response.status });
        }

        // The server fetched the image itself (Pollinations key, or local development).
        if (!isJson) {
          if (freeTier) nextFreeAt = Date.now() + FREE_WAIT * 1000;
          return { blob: await response.blob(), seed: Number(response.headers.get("X-Image-Seed")) || seed };
        }

        ({ url, seed } = data);
      }

      // This browser fetches the image (its own 45-second allowance).
      const image = await fetch(url).catch(() => null);

      if (image?.ok && image.headers.get("content-type")?.startsWith("image/")) {
        nextFreeAt = Date.now() + FREE_WAIT * 1000;
        return { blob: await image.blob(), seed };
      }

      if (image && [402, 429].includes(image.status)) {
        const message = (await image.json().catch(() => ({})))?.error?.message || "";

        pause(Number(/(\d+)\s*s/.exec(message)?.[1]) || FREE_WAIT, item);
        continue;
      }

      throw new Error("The image service didn't answer. Please try again.");
    }

    throw Object.assign(new Error(stopRef.current ? "Stopped." : "The image service is busy. Try again in a minute."), {
      stopped: stopRef.current,
    });
  };

  const run = async (jobs) => {
    if (!pro) {
      onLocked();
      return;
    }

    if (jobs.length === 0) return;

    stopRef.current = false;
    setRunning(true);
    setError("");
    setItems((current) => [...jobs, ...current]);

    for (const job of jobs) {
      if (stopRef.current) {
        update(job.id, { status: "error", error: "Stopped." });
        continue;
      }

      update(job.id, { status: Date.now() < nextFreeAt ? "queued" : "loading" });

      try {
        const { blob, seed } = await createOne(job);

        update(job.id, { status: "done", blob, seed, url: URL.createObjectURL(blob) });
      } catch (err) {
        update(job.id, { status: "error", error: err.message });

        // Limits and setup problems affect every image: stop the rest.
        if ([402, 429, 503].includes(err.status) || err.stopped) {
          stopRef.current = true;
          if (!err.stopped) setError(err.message);
        }
      }
    }

    setCountdown(0);
    setRunning(false);
  };

  const newJobs = (base, n) =>
    Array.from({ length: n }, () => ({
      id: nextId++,
      prompt: base.prompt,
      style: base.style,
      shape: base.shape,
      enhance: base.enhance,
      seed: Math.floor(Math.random() * 1e9),
      status: "queued",
    }));

  const generate = () => {
    const text = prompt.trim();

    if (pro && text.length < 3) {
      setError("Describe the image you want (a few words at least).");
      promptRef.current?.focus();
      return;
    }

    run(newJobs({ prompt: text, style, shape, enhance }, count));
  };

  const removeItem = (id) => {
    const target = items.find((i) => i.id === id);

    if (target?.url) URL.revokeObjectURL(target.url);
    setItems(items.filter((i) => i.id !== id));
  };

  const asFile = (item) => new File([item.blob], fileNameFor(item), { type: item.blob.type });
  const done = items.filter((i) => i.status === "done");
  const shapeRatio = (id) => SHAPES.find((s) => s.id === id)?.ratio || "1 / 1";

  const buttonLabel = running
    ? countdown > 0
      ? `Next image in ${countdown}s`
      : "Creating…"
    : !pro
      ? "Unlock with Pro"
      : `Create ${count} image${count === 1 ? "" : "s"}`;

  return (
    <main className="layout create-page">
      <section className="workspace">
        <div className="panel create-prompt">
          <span className="eyebrow">Step 01 · Describe it</span>
          <h2>Create images from words</h2>

          <label className="sr-only" htmlFor="create-prompt">Describe the image, or type keywords</label>
          <textarea
            id="create-prompt"
            ref={promptRef}
            value={prompt}
            onChange={(e) => set({ prompt: e.target.value.slice(0, 600) })}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && !running) generate();
            }}
            placeholder="Describe the image, or type keywords: a red vintage bicycle, brick wall, morning light…"
            spellCheck
          />

          <div className="create-keywords" aria-label="Add a keyword">
            {KEYWORDS.map((word) => (
              <button key={word} type="button" onClick={() => addKeyword(word)}>
                + {word}
              </button>
            ))}
          </div>

          {error && <p className="form-error">{error}</p>}
        </div>

        <div className="panel">
          <div className="panel-head">
            <span className="panel-icon">{Icon.sparkle}</span>
            <div>
              <h3>Your images</h3>
              <p>
                {items.length === 0
                  ? "New images appear here"
                  : `${done.length} image${done.length === 1 ? "" : "s"}${running ? " · creating more" : ""}`}
              </p>
            </div>
            {items.length > 0 && !running && (
              <button
                className="text-btn"
                onClick={() => {
                  items.forEach((i) => i.url && URL.revokeObjectURL(i.url));
                  setItems([]);
                }}
              >
                Clear all
              </button>
            )}
          </div>

          {items.length === 0 ? (
            <div className="create-examples">
              <span className="eyebrow">Try one of these</span>
              {EXAMPLES.map((example) => (
                <button key={example} type="button" onClick={() => set({ prompt: example })}>
                  {Icon.arrow} {example}
                </button>
              ))}
            </div>
          ) : (
            <div className="create-grid">
              {items.map((item) => (
                <figure key={item.id} className={`create-card is-${item.status}`}>
                  <div className="create-frame" style={{ aspectRatio: shapeRatio(item.shape) }}>
                    {item.status === "done" ? (
                      <img src={item.url} alt={item.prompt} />
                    ) : item.status === "error" ? (
                      <p className="create-error">{item.error}</p>
                    ) : (
                      <div className="create-developing">
                        <span className="create-spinner" aria-hidden="true">{Icon.aperture}</span>
                        <span>
                          {item.status === "queued"
                            ? countdown > 0
                              ? `Waiting ${countdown}s`
                              : "Waiting…"
                            : "Developing…"}
                        </span>
                      </div>
                    )}
                  </div>

                  <figcaption>
                    <p title={item.prompt}>{item.prompt}</p>

                    <div className="create-actions">
                      {item.status === "done" && (
                        <>
                          <button type="button" className="is-main" onClick={() => saveBlob(item.blob, fileNameFor(item))}>
                            {Icon.download} Download
                          </button>
                          <button type="button" onClick={() => onSendToConverter([{ file: asFile(item) }])} title="Convert & compress">
                            {Icon.aperture} Convert
                          </button>
                          <button type="button" onClick={() => onSendToNames([asFile(item)])} title="Write a file name and alt text">
                            {Icon.sparkle} Name & alt
                          </button>
                          <button
                            type="button"
                            onClick={() => run(newJobs(item, 1))}
                            disabled={running}
                            title="Make another version"
                          >
                            {Icon.refresh} Variation
                          </button>
                        </>
                      )}
                      {item.status === "error" && (
                        <button type="button" onClick={() => run(newJobs(item, 1))} disabled={running}>
                          {Icon.refresh} Try again
                        </button>
                      )}
                      {(item.status === "done" || item.status === "error") && (
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
          <span className="eyebrow">Step 02 · The look</span>

          <div className="field">
            <label>Style</label>
            <div className="format-grid create-styles">
              {STYLES.map(({ id, label, note }) => (
                <button
                  key={id}
                  className={`format-tile ${style === id ? "is-active" : ""}`}
                  onClick={() => set({ style: id })}
                  aria-pressed={style === id}
                >
                  <span className="format-check">{Icon.check}</span>
                  <strong>{label}</strong>
                  <small>{note}</small>
                </button>
              ))}
            </div>
          </div>

          <div className="field">
            <label>Shape</label>
            <div className="create-shapes" role="group" aria-label="Shape">
              {SHAPES.map(({ id, label, ratio }) => (
                <button
                  key={id}
                  className={shape === id ? "is-active" : ""}
                  onClick={() => set({ shape: id })}
                  aria-pressed={shape === id}
                >
                  <i style={{ aspectRatio: ratio }} aria-hidden="true" />
                  {label}
                </button>
              ))}
            </div>
          </div>

          <div className="field">
            <label>How many</label>
            <div className="segmented create-count" role="group" aria-label="How many images">
              {[1, 2, 3, 4].map((n) => (
                <button key={n} className={count === n ? "is-active" : ""} onClick={() => set({ count: n })} aria-pressed={count === n}>
                  {n}
                </button>
              ))}
            </div>
          </div>

          <label className="create-toggle">
            <input type="checkbox" checked={enhance} onChange={(e) => set({ enhance: e.target.checked })} />
            <span>
              <strong>Improve my prompt</strong>
              <small>AI adds detail to short descriptions</small>
            </span>
          </label>

          <button
            className={`develop-btn ${running ? "is-busy" : ""}`}
            onClick={generate}
            disabled={running || !account}
          >
            <span className="develop-fill" aria-hidden="true" />
            <span className="develop-label">
              {!pro && !running && Icon.lock}
              {pro && !running && Icon.sparkle}
              {buttonLabel}
              {pro && !running && Icon.arrow}
            </span>
          </button>

          {running && (
            <button type="button" className="create-stop" onClick={() => (stopRef.current = true)}>
              Stop after this image
            </button>
          )}

          <p className="hint">
            {!pro
              ? "A Pro feature. Everyone can look around; Pro creates the images."
              : freeTier && count > 1
                ? `Free image service: one image every ${FREE_WAIT} seconds, so ${count} take about ${Math.ceil((count * FREE_WAIT) / 60)} min`
                : "Ctrl + Enter creates too"}
          </p>
        </div>
      </aside>
    </main>
  );
}
