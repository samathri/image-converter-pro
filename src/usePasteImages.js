import { useEffect, useRef } from "react";

const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/avif"];
const EXTENSIONS = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/avif": "avif" };

let pasteCount = 0;

/**
 * Pasted images get a clear, unique name ("pasted-image-1.png"); files copied
 * from a folder keep their own names.
 */
function named(file) {
  if (file.name && !/^image\.(png|jpe?g|webp|avif)$/i.test(file.name)) return file;

  const ext = EXTENSIONS[file.type] || "png";

  return new File([file], `pasted-image-${++pasteCount}.${ext}`, { type: file.type });
}

const onlyImages = (files) => files.filter((f) => IMAGE_TYPES.includes(f.type)).map(named);

/** Ctrl+V anywhere on the page adds the pasted images (unless typing in a text box). */
export function usePasteImages(onFiles, enabled = true) {
  const callback = useRef(onFiles);

  callback.current = onFiles;

  useEffect(() => {
    if (!enabled) return;

    const onPaste = (e) => {
      const files = onlyImages(Array.from(e.clipboardData?.files || []));

      if (files.length === 0) return; // plain text: let text boxes handle it

      e.preventDefault();
      callback.current(files);
    };

    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [enabled]);
}

/**
 * For a "paste" button: reads images from the clipboard (the browser may ask
 * for permission). Returns the images, or a message explaining why not.
 */
export async function readClipboardImages() {
  if (!navigator.clipboard?.read) {
    return { files: [], message: "Press Ctrl+V (⌘V on a Mac) to paste." };
  }

  try {
    const files = [];

    for (const item of await navigator.clipboard.read()) {
      const type = item.types.find((t) => IMAGE_TYPES.includes(t));

      if (type) files.push(new File([await item.getType(type)], "image." + EXTENSIONS[type], { type }));
    }

    return files.length > 0
      ? { files: onlyImages(files), message: "" }
      : { files: [], message: "There's no image on the clipboard. Copy an image first, then paste." };
  } catch {
    return { files: [], message: "Press Ctrl+V (⌘V on a Mac) to paste." };
  }
}
