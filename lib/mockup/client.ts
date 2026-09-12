"use client";

/**
 * Browser raster adapter — `<canvas>` / `<img>` ⇄ {@link Raster}. Client-only;
 * kept out of `index.ts` (mirrors `server.ts`). The compositor is DOM-free; this
 * just moves pixels in and out of it in the browser.
 */

import type { Raster } from "./types";

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("image decode failed"));
    img.src = url;
  });
}

/**
 * Decode an image Blob into a straight-alpha RGBA raster. Optionally shrink it
 * during decode — `scale` (an explicit factor) or `maxSide` (longest edge cap)
 * — to keep browser-side preview buffers small.
 */
export async function blobToRaster(
  blob: Blob,
  opts: { scale?: number; maxSide?: number } = {},
): Promise<Raster> {
  const url = URL.createObjectURL(blob);
  try {
    const img = await loadImage(url);
    let width = img.naturalWidth;
    let height = img.naturalHeight;
    if (opts.scale && opts.scale > 0 && opts.scale !== 1) {
      width = Math.max(1, Math.round(width * opts.scale));
      height = Math.max(1, Math.round(height * opts.scale));
    } else if (opts.maxSide && Math.max(width, height) > opts.maxSide) {
      const s = opts.maxSide / Math.max(width, height);
      width = Math.max(1, Math.round(width * s));
      height = Math.max(1, Math.round(height * s));
    }
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) throw new Error("2D canvas context unavailable");
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(img, 0, 0, width, height);
    return { data: ctx.getImageData(0, 0, width, height).data, width, height };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** `data:<mime>;base64,...` → Blob. */
export function dataUrlToBlob(dataUrl: string): Blob {
  const comma = dataUrl.indexOf(",");
  const header = dataUrl.slice(0, comma);
  const mime = /data:([^;]+)/.exec(header)?.[1] ?? "application/octet-stream";
  const binary = atob(dataUrl.slice(comma + 1));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

/** Paint a raster into a canvas element, resizing it to match. */
export function rasterToCanvas(r: Raster, canvas: HTMLCanvasElement): void {
  if (canvas.width !== r.width) canvas.width = r.width;
  if (canvas.height !== r.height) canvas.height = r.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.putImageData(
    new ImageData(new Uint8ClampedArray(r.data), r.width, r.height),
    0,
    0,
  );
}

/** Encode a raster as a `data:` URL — a lightweight, off-DOM thumbnail for grids/lists. */
export function rasterToDataUrl(r: Raster, mime = "image/jpeg", quality = 0.72): string {
  const canvas = document.createElement("canvas");
  rasterToCanvas(r, canvas);
  return canvas.toDataURL(mime, quality);
}
