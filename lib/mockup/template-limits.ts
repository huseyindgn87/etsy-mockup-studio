/**
 * Limits for a user-uploaded mockup template (see AGENTS.md: the curated
 * library is maintainer-managed, but users may calibrate their own JPEG/PNG
 * the same way). Server-only — pulls in `sharp` to sniff the real decoded
 * format/dimensions rather than trusting the client's declared MIME type.
 */

import sharp from "sharp";

export const MAX_TEMPLATE_UPLOAD_BYTES = 15 * 1024 * 1024;
export const MIN_TEMPLATE_SHORT_EDGE = 1500;
export const ACCEPTED_TEMPLATE_FORMATS = new Set(["jpeg", "png"]);

export interface TemplateUploadOk {
  ok: true;
  format: "jpeg" | "png";
  width: number;
  height: number;
}
export interface TemplateUploadErr {
  ok: false;
  error: string;
}

/**
 * Validates a candidate template upload: size cap, real decoded format (JPEG
 * or PNG only — sniffed via `sharp`, not the caller's `Content-Type` header),
 * and a minimum short-edge resolution so the print area has enough detail.
 */
export async function validateTemplateUpload(bytes: Buffer): Promise<TemplateUploadOk | TemplateUploadErr> {
  if (bytes.byteLength === 0) {
    return { ok: false, error: "The file is empty." };
  }
  if (bytes.byteLength > MAX_TEMPLATE_UPLOAD_BYTES) {
    return {
      ok: false,
      error: `File too large (max ${Math.round(MAX_TEMPLATE_UPLOAD_BYTES / 1024 / 1024)} MB).`,
    };
  }

  let metadata;
  try {
    metadata = await sharp(bytes).metadata();
  } catch {
    return { ok: false, error: "Could not read this file as an image." };
  }

  const format = metadata.format;
  if (format !== "jpeg" && format !== "png") {
    return { ok: false, error: "Only JPEG and PNG images are accepted." };
  }

  const width = metadata.width ?? 0;
  const height = metadata.height ?? 0;
  if (width <= 0 || height <= 0) {
    return { ok: false, error: "Could not read this file as an image." };
  }
  const shortEdge = Math.min(width, height);
  if (shortEdge < MIN_TEMPLATE_SHORT_EDGE) {
    return {
      ok: false,
      error: `Image is too small — the shorter side must be at least ${MIN_TEMPLATE_SHORT_EDGE}px (this one is ${shortEdge}px).`,
    };
  }

  return { ok: true, format, width, height };
}
