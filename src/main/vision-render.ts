import { createRequire } from "node:module";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { MAX_IMAGE_BYTES } from "../shared/vision";

const MAX_SIDE = 1600;
const MAX_PIXELS = 40_000_000;

export function imageFormat(bytes: Uint8Array): "png" | "jpeg" {
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES)
    throw new Error("Choose a PNG or JPEG image smaller than 50 MB.");
  if (
    Buffer.from(bytes.subarray(0, 8)).equals(
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    )
  )
    return "png";
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "jpeg";
  throw new Error("Only PNG and JPEG images are supported.");
}

/** Decode locally, bound resolution, and strip metadata before sending pixels to the model. */
export async function renderImage(bytes: Uint8Array): Promise<Buffer> {
  imageFormat(bytes);
  const image = await loadImage(Buffer.from(bytes));
  if (!image.width || !image.height || image.width * image.height > MAX_PIXELS)
    throw new Error(
      "This image is too large. Use an image with at most 40 million pixels.",
    );
  const scale = Math.min(1, MAX_SIDE / Math.max(image.width, image.height));
  const canvas = createCanvas(
    Math.max(1, Math.round(image.width * scale)),
    Math.max(1, Math.round(image.height * scale)),
  );
  const context = canvas.getContext("2d");
  context.fillStyle = "white";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  return canvas.toBuffer("image/png");
}

export async function renderPdfPage(
  bytes: Uint8Array,
  page: number,
): Promise<Buffer> {
  if (!Number.isSafeInteger(page) || page < 1)
    throw new Error("Choose a valid PDF page number.");
  const require = createRequire(import.meta.url);
  const assets = require
    .resolve("pdfjs-dist/package.json")
    .replace(/package\.json$/, "");
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const task = pdfjs.getDocument({
    data: new Uint8Array(bytes),
    useSystemFonts: true,
    cMapUrl: `${assets}cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${assets}standard_fonts/`,
    wasmUrl: `${assets}wasm/`,
  });
  try {
    const pdf = await task.promise;
    if (page > pdf.numPages)
      throw new Error(`This PDF has ${pdf.numPages} pages.`);
    const current = await pdf.getPage(page);
    const original = current.getViewport({ scale: 1 });
    const viewport = current.getViewport({
      scale: Math.min(2, MAX_SIDE / Math.max(original.width, original.height)),
    });
    const canvas = createCanvas(
      Math.ceil(viewport.width),
      Math.ceil(viewport.height),
    );
    await current.render({
      canvas: canvas as never,
      canvasContext: canvas.getContext("2d") as never,
      viewport,
    }).promise;
    return canvas.toBuffer("image/png");
  } finally {
    await task.destroy();
  }
}
