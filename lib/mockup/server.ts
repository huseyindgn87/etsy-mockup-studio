/**
 * Server-only raster adapter: bytes (PNG/JPEG/…) ⇄ {@link Raster}.
 *
 * Kept OUT of `index.ts` — it pulls in `sharp` (a native dependency) and must
 * never reach the browser bundle. The isomorphic compositor imports nothing
 * from here; routes import this and `./compose` side by side.
 *
 * Locked decision (memory `mockup-screen-migration`): `sharp` for encode /
 * resize; the compositing math stays pure-buffer.
 */

import sharp from "sharp";
import type { Raster } from "./types";

/** Decode an encoded image to a straight-alpha RGBA {@link Raster}. */
export async function decodeToRaster(input: Buffer | Uint8Array): Promise<Raster> {
  const { data, info } = await sharp(input)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return {
    data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength),
    width: info.width,
    height: info.height,
  };
}

export interface EncodeOptions {
  format?: "png" | "jpeg";
  /** JPEG quality, 1..100. Ignored for PNG. */
  quality?: number;
  /** Matte for JPEG (no alpha channel). Defaults to white. */
  background?: { r: number; g: number; b: number };
}

/** Encode a {@link Raster} to PNG (default) or JPEG bytes. */
export async function encodeRaster(
  r: Raster,
  opts: EncodeOptions = {},
): Promise<Buffer> {
  const raw = Buffer.from(r.data.buffer, r.data.byteOffset, r.data.byteLength);
  const img = sharp(raw, {
    raw: { width: r.width, height: r.height, channels: 4 },
  });
  if (opts.format === "jpeg") {
    return img
      .flatten({ background: opts.background ?? { r: 255, g: 255, b: 255 } })
      .jpeg({ quality: opts.quality ?? 92 })
      .toBuffer();
  }
  return img.png().toBuffer();
}

/** Encode straight to a `data:` URL (used by the PSD parse route). */
export async function encodeRasterDataUrl(
  r: Raster,
  opts: EncodeOptions = {},
): Promise<string> {
  const buf = await encodeRaster(r, opts);
  const mime = opts.format === "jpeg" ? "image/jpeg" : "image/png";
  return `data:${mime};base64,${buf.toString("base64")}`;
}
