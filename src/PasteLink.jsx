import { readClipboardImages } from "./usePasteImages.js";

/** "paste" inside a drop area: adds images from the clipboard. */
export default function PasteLink({ onFiles, onMessage }) {
  const paste = async (e) => {
    e.stopPropagation(); // don't also open the file picker

    const { files, message } = await readClipboardImages();

    if (files.length > 0) onFiles(files);
    else onMessage(message);
  };

  return (
    <button type="button" className="paste-link" onClick={paste} onKeyDown={(e) => e.stopPropagation()}>
      paste
    </button>
  );
}
