import sharp from "sharp";
import axios from "axios";
import dns from "dns/promises";
import net from "net";

function encode(input, format, quality) {
  const image = sharp(input);

  switch (format) {
    case "jpg":
    case "jpeg":
      return image
        .jpeg({
          quality,
          mozjpeg: true,
        })
        .toBuffer();

    case "webp":
      return image
        .webp({
          quality,
        })
        .toBuffer();

    case "avif":
      return image
        .avif({
          quality,
        })
        .toBuffer();

    default:
      throw new Error(
        `Unsupported format: ${format}`
      );
  }
}

// Same strategy as the desktop app: PNG reduces palette
// colors, lossy formats binary-search the quality value.
export async function compressToTarget(
  input,
  format,
  targetBytes
) {
  if (format === "png") {
    const colorSteps = [256, 128, 64, 32, 16, 8];
    let output;

    for (const colors of colorSteps) {
      output = await sharp(input)
        .png({
          compressionLevel: 9,
          palette: true,
          colors,
        })
        .toBuffer();

      if (output.length <= targetBytes) {
        break;
      }
    }

    return output;
  }

  let minQuality = 1;
  let maxQuality = 100;

  let bestOutput = null;
  let bestSize = Infinity;

  while (minQuality <= maxQuality) {
    const quality = Math.floor(
      (minQuality + maxQuality) / 2
    );

    const output = await encode(
      input,
      format,
      quality
    );

    if (
      Math.abs(output.length - targetBytes) <
      Math.abs(bestSize - targetBytes)
    ) {
      bestSize = output.length;
      bestOutput = output;
    }

    if (output.length > targetBytes) {
      maxQuality = quality - 1;
    } else {
      minQuality = quality + 1;
    }
  }

  return bestOutput;
}

function isPrivateAddress(address) {
  if (net.isIPv4(address)) {
    const [a, b] = address.split(".").map(Number);

    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      a >= 224
    );
  }

  const lower = address.toLowerCase();

  if (lower.startsWith("::ffff:")) {
    return isPrivateAddress(lower.slice(7));
  }

  return (
    lower === "::" ||
    lower === "::1" ||
    lower.startsWith("fc") ||
    lower.startsWith("fd") ||
    lower.startsWith("fe80")
  );
}

// On a public server, fetching arbitrary URLs could be used to
// reach internal services, so only public hosts are allowed.
async function assertPublicUrl(url) {
  let parsed;

  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Invalid URL");
  }

  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("Only http and https URLs are allowed");
  }

  const host = parsed.hostname.replace(/^\[|\]$/g, "");
  const addresses = net.isIP(host)
    ? [{ address: host }]
    : await dns.lookup(host, { all: true });

  if (addresses.some((a) => isPrivateAddress(a.address))) {
    throw new Error("URL points to a private network address");
  }
}

export async function downloadImage(url, maxBytes) {
  let currentUrl = url;
  let response;

  // Follow redirects by hand so every hop is checked.
  for (let hop = 0; hop <= 5; hop++) {
    await assertPublicUrl(currentUrl);

    response = await axios.get(currentUrl, {
      responseType: "arraybuffer",
      timeout: 30000,
      maxRedirects: 0,
      maxContentLength: maxBytes,
      validateStatus: (s) => s < 400,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
      },
    });

    if (response.status < 300 || response.status >= 400) {
      break;
    }

    const location = response.headers.location;

    if (!location || hop === 5) {
      throw new Error("Too many redirects");
    }

    currentUrl = new URL(location, currentUrl).toString();
  }

  const contentType =
    response.headers["content-type"];

  if (
    !contentType ||
    !contentType.startsWith("image/")
  ) {
    throw new Error(
      `URL is not an image. Content-Type: ${contentType}`
    );
  }

  const buffer = Buffer.from(response.data);

  // verify image
  await sharp(buffer).metadata();

  const urlName = decodeURIComponent(
    new URL(url).pathname.split("/").pop() || ""
  );

  return {
    buffer,
    name: urlName || `download_${Date.now()}`,
  };
}
