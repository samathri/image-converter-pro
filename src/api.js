export async function fetchJson(url, options = {}) {
  const init = { ...options };

  if (init.json !== undefined) {
    init.body = JSON.stringify(init.json);
    init.headers = { "Content-Type": "application/json", ...init.headers };
    delete init.json;
  }

  const response = await fetch(url, init);
  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    const error = new Error(data.message || "Request failed.");

    error.status = response.status;
    error.code = data.code;
    error.data = data;
    throw error;
  }

  return data;
}

function safeFileName(name) {
  const cleaned = String(name).replace(/[^\w.-]+/g, "_").replace(/^[.-]+/, "");

  return (cleaned || "file").slice(-80);
}

// Local development: post the file to our own server, with progress.
function uploadLocal(file, pathname, purpose, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const body = new FormData();

    body.append("purpose", purpose);
    body.append("pathname", pathname);
    body.append("file", file);

    xhr.open("POST", "/api/uploads/local");
    xhr.responseType = "json";
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded / e.total);
    xhr.onload = () =>
      xhr.status < 300
        ? resolve(xhr.response.pathname)
        : reject(new Error(xhr.response?.message || "Upload failed."));
    xhr.onerror = () => reject(new Error("Could not reach the server."));
    xhr.send(body);
  });
}

/**
 * Uploads a file to storage and returns its stored pathname.
 * On Vercel the browser uploads straight to Vercel Blob, so large files
 * never pass through the 4.5 MB function limit.
 */
export async function uploadFile(file, { account, purpose = "image", onProgress } = {}) {
  const prefix = purpose === "receipt" ? account.receiptPrefix : account.uploadPrefix;
  const pathname = `${prefix}${safeFileName(file.name)}`;

  if (account.storage !== "blob") {
    return uploadLocal(file, pathname, purpose, onProgress);
  }

  const { uploadPresigned } = await import("@vercel/blob/client");

  try {
    const blob = await uploadPresigned(pathname, file, {
      access: "private",
      handleUploadUrl: "/api/uploads",
      clientPayload: JSON.stringify({ purpose }),
      multipart: file.size > 8 * 1024 * 1024,
      onUploadProgress: ({ percentage }) => onProgress?.(percentage / 100),
    });

    return blob.pathname;
  } catch (error) {
    // The SDK wraps our server's message; show something readable.
    const message = String(error.message || "").replace(/^Vercel Blob:\s*/i, "");

    throw new Error(message || "Upload failed.");
  }
}

function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");

  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

/** Downloads a (signed, possibly cross-origin) file URL under a chosen name. */
export async function downloadFile(url, filename) {
  try {
    const response = await fetch(url);

    if (!response.ok) throw new Error();
    saveBlob(await response.blob(), filename);
  } catch {
    // If the storage host doesn't allow fetch, let the browser open it.
    window.location.href = url;
  }
}

export function formatMoney(amount, currency) {
  // Whole amounts read better without ".00" (Rs 1,500 not Rs 1,500.00).
  const digits = Number.isInteger(Number(amount)) ? 0 : 2;

  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
      currencyDisplay: "narrowSymbol",
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    }).format(amount);
  } catch {
    return `${currency} ${amount}`;
  }
}

export function formatDate(iso, options = { day: "numeric", month: "long", year: "numeric" }) {
  if (!iso) return "";

  // SQLite timestamps have no timezone; they are UTC.
  const normalized = /\d{2}:\d{2}:\d{2}$/.test(iso)
    ? `${iso.replace(" ", "T")}Z`
    : iso;

  return new Date(normalized).toLocaleDateString(undefined, options);
}
