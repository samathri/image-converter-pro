// Removes image backgrounds in the browser (a Web Worker, so the page stays
// responsive). Uses BRIA's RMBG-1.4 model through transformers.js; the model
// (~44 MB) downloads once and is then cached by the browser.
import { AutoModel, AutoProcessor, RawImage, env } from "@huggingface/transformers";

const MODEL = "briaai/RMBG-1.4";

env.allowLocalModels = false;

let ready;

function load() {
  ready ||= (async () => {
    const files = new Map();

    const progress_callback = (event) => {
      if (event.status === "progress" && event.total) {
        files.set(event.file, event);

        const loaded = [...files.values()].reduce((sum, f) => sum + f.loaded, 0);
        const total = [...files.values()].reduce((sum, f) => sum + f.total, 0);

        self.postMessage({ type: "loading", loaded, total });
      }
    };

    const [model, processor] = await Promise.all([
      AutoModel.from_pretrained(MODEL, { config: { model_type: "custom" }, dtype: "q8", progress_callback }),
      AutoProcessor.from_pretrained(MODEL, {
        config: {
          do_normalize: true,
          do_pad: false,
          do_rescale: true,
          do_resize: true,
          image_mean: [0.5, 0.5, 0.5],
          image_std: [1, 1, 1],
          feature_extractor_type: "ImageFeatureExtractor",
          resample: 2,
          rescale_factor: 0.00392156862745098,
          size: { width: 1024, height: 1024 },
        },
      }),
    ]);

    self.postMessage({ type: "ready" });
    return { model, processor };
  })().catch((error) => {
    ready = null; // try again next time
    throw error;
  });

  return ready;
}

self.onmessage = async ({ data }) => {
  const { id, blob } = data;

  try {
    const { model, processor } = await load();
    const image = await RawImage.fromBlob(blob);
    const { pixel_values } = await processor(image);
    const { output } = await model({ input: pixel_values });

    // The model gives a 1024×1024 mask; scale it to the image and use it as alpha.
    const mask = await RawImage.fromTensor(output[0].mul(255).to("uint8")).resize(image.width, image.height);
    const cutout = image.rgb().clone();

    cutout.putAlpha(mask);

    self.postMessage({ type: "done", id, blob: await cutout.toBlob("image/png") });
  } catch (error) {
    self.postMessage({ type: "error", id, message: error?.message || "Couldn't remove the background." });
  }
};
