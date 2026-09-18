/**
 * The only form a template image leaves the server in for a regular user: a
 * downscaled JPEG with the Listhouse wordmark tiled across it. Renders read
 * the raw file server-side (`readTemplateForRender`); only admins get it as-is.
 * Server-only — uses `sharp`.
 */

import sharp from "sharp";
import { APP_NAME } from "@/lib/brand";

/** Longest edge of a preview — matches the editor's own preview raster size. */
export const TEMPLATE_PREVIEW_MAX = 1400;

function watermarkSvg(width: number, height: number): Buffer {
  const size = Math.max(14, Math.round(Math.min(width, height) / 14));
  const tileW = size * 9;
  const tileH = size * 5;
  const text = APP_NAME.toUpperCase();
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">` +
      `<defs><pattern id="w" width="${tileW}" height="${tileH}" patternUnits="userSpaceOnUse" patternTransform="rotate(-30)">` +
      `<text x="${tileW / 2}" y="${tileH / 2}" text-anchor="middle" dominant-baseline="middle" ` +
      `font-family="Helvetica, Arial, sans-serif" font-size="${size}" font-weight="700" letter-spacing="${size / 6}" ` +
      `fill="#ffffff" fill-opacity="0.35" stroke="#000000" stroke-opacity="0.18" stroke-width="${Math.max(1, size / 24)}">${text}</text>` +
      `</pattern></defs><rect width="100%" height="100%" fill="url(#w)"/></svg>`,
  );
}

/** A watermarked preview of `raw`, plus the original's size (calibration and renders use native pixels). */
export async function templatePreview(
  raw: Buffer,
): Promise<{ body: Buffer; contentType: string; width: number; height: number }> {
  const meta = await sharp(raw).metadata();
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
  const resized = await sharp(raw)
    .rotate()
    .resize(TEMPLATE_PREVIEW_MAX, TEMPLATE_PREVIEW_MAX, { fit: "inside", withoutEnlargement: true })
    .flatten({ background: "#ffffff" })
    .toBuffer({ resolveWithObject: true });
  const body = await sharp(resized.data)
    .composite([{ input: watermarkSvg(resized.info.width, resized.info.height) }])
    .jpeg({ quality: 82 })
    .toBuffer();
  return { body, contentType: "image/jpeg", width, height };
}
