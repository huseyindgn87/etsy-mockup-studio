/**
 * Browser-side rendering and upload of a listing's images at schedule time
 * (the editor's "Schedule for later"). A scheduled listing is rendered once,
 * here, and the finished JPEGs go to R2 — the runner that publishes it later
 * only forwards them to Etsy and never composites anything.
 *
 * Rendering uses the same `compose()` core as the photo-grid thumbnails and
 * the server's Publish render, at the mockup's full native resolution, and
 * the same JPEG size window as the server (`DEFAULT_TARGET_MB` in
 * app/api/mockups/render/route.ts). Client-only: needs `<canvas>`.
 */

import { MAX_IMAGE_SIZE_BYTES, MAX_LISTING_IMAGES } from "@/lib/etsy/listing-image-limits";
import { blobToRaster, rasterToCanvas } from "@/lib/mockup/client";
import { compose } from "@/lib/mockup/compose";
import { searchJpegQuality } from "@/lib/mockup/encode-search";
import type { Calibration, Overlay, Raster } from "@/lib/mockup/types";
import { normalizeBlendMode } from "@/lib/mockup/validate";
import { imageSlot } from "@/lib/scheduling/render-keys";
import type { ScheduleContentInput } from "@/lib/scheduling/types";

const TARGET_MIN_BYTES = 1.2 * 1024 * 1024;
const TARGET_MAX_BYTES = 1.7 * 1024 * 1024;
const OWN_IMAGE_TYPES = ["image/jpeg", "image/png", "image/gif"];

export interface RenderableMockup {
  name: string;
  /** The composite at native (PSD) resolution. */
  file: File;
  psdW: number;
  psdH: number;
  calibration: Calibration;
  overlays: { file: File; x: number; y: number; blend: string; alpha: number; clip: boolean; name: string }[];
}

export interface RenderableDesign {
  name: string;
  /** The original upload — the editor's own raster is downscaled for preview. */
  file: File;
}

export type ScheduleImageSource =
  | { kind: "render"; mockup: RenderableMockup; design: RenderableDesign; altText?: string }
  | { kind: "own"; file: File; altText?: string };

export interface PreparedImage {
  blob: Blob;
  filename: string;
  contentType: string;
  altText?: string;
}

function canvasToJpeg(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("The browser couldn't encode the image."))),
      "image/jpeg",
      quality,
    );
  });
}

/** JPEG on a white background (like the server's flatten), sized into the target window. */
async function encodeJpeg(raster: Raster): Promise<Blob> {
  const source = document.createElement("canvas");
  rasterToCanvas(raster, source);
  const canvas = document.createElement("canvas");
  canvas.width = raster.width;
  canvas.height = raster.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2D canvas context unavailable.");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(source, 0, 0);

  const trials = new Map<number, Blob>();
  const search = await searchJpegQuality(
    async (quality) => {
      const blob = await canvasToJpeg(canvas, quality);
      trials.set(quality, blob);
      return blob.size;
    },
    { min: TARGET_MIN_BYTES, max: TARGET_MAX_BYTES },
  );
  return trials.get(search.quality) ?? canvasToJpeg(canvas, search.quality);
}

/** One mockup × design, composited at full resolution and encoded as JPEG. */
export async function renderMockupJpeg(mockup: RenderableMockup, design: RenderableDesign): Promise<Blob> {
  const [mock, designRaster, overlayRasters] = await Promise.all([
    blobToRaster(mockup.file),
    blobToRaster(design.file),
    Promise.all(mockup.overlays.map((o) => blobToRaster(o.file))),
  ]);
  const overlays: Overlay[] = overlayRasters.map((r, i) => {
    const o = mockup.overlays[i];
    return {
      data: r.data,
      x: Math.round(o.x),
      y: Math.round(o.y),
      w: r.width,
      h: r.height,
      blend: normalizeBlendMode(o.blend),
      alpha: Math.min(1, Math.max(0, o.alpha)),
      clip: !!o.clip,
      name: o.name,
    };
  });
  const W = mockup.psdW > 0 ? Math.round(mockup.psdW) : mock.width;
  const H = mockup.psdH > 0 ? Math.round(mockup.psdH) : mock.height;
  const out = compose({ mock, design: designRaster, perArea: null, calibration: mockup.calibration, overlays }, W, H);
  return encodeJpeg(out);
}

const yieldToBrowser = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * Renders every mockup and gathers the user's own photos, in listing order
 * (the first {@link MAX_LISTING_IMAGES}, same as Publish). Throws with a
 * message naming the image that failed.
 */
export async function prepareScheduleImages(
  sources: ScheduleImageSource[],
  onProgress: (done: number, total: number) => void,
): Promise<PreparedImage[]> {
  const capped = sources.slice(0, MAX_LISTING_IMAGES);
  const prepared: PreparedImage[] = [];
  for (let i = 0; i < capped.length; i++) {
    onProgress(i, capped.length);
    await yieldToBrowser();
    const source = capped[i];
    if (source.kind === "render") {
      let blob: Blob;
      try {
        blob = await renderMockupJpeg(source.mockup, source.design);
      } catch (err) {
        const reason = err instanceof Error ? err.message : "unknown error";
        throw new Error(`Rendering image ${i + 1} (${source.design.name} × ${source.mockup.name}) failed: ${reason}`);
      }
      if (blob.size > MAX_IMAGE_SIZE_BYTES) {
        throw new Error(`Image ${i + 1} rendered larger than Etsy's 10 MB limit.`);
      }
      prepared.push({
        blob,
        filename: `${source.design.name}_${source.mockup.name}.jpg`,
        contentType: "image/jpeg",
        altText: source.altText,
      });
    } else {
      const contentType = source.file.type === "image/jpg" ? "image/jpeg" : source.file.type;
      if (!OWN_IMAGE_TYPES.includes(contentType)) {
        throw new Error(`Photo ${i + 1} (${source.file.name}) isn't a JPEG, PNG or GIF.`);
      }
      prepared.push({ blob: source.file, filename: source.file.name, contentType, altText: source.altText });
    }
  }
  onProgress(capped.length, capped.length);
  return prepared;
}

async function errorText(res: Response): Promise<string> {
  const body = (await res.json().catch(() => null)) as { error?: string } | null;
  return body?.error || `request failed (${res.status})`;
}

/**
 * Uploads prepared images to a new render set, one slot each, and returns
 * the content half of the schedule request. Throws with the server's reason
 * on the first failure.
 */
export async function uploadScheduleImages(
  prepared: PreparedImage[],
  onProgress: (done: number, total: number) => void,
): Promise<Omit<ScheduleContentInput, "publishSpec">> {
  const renderSetId = crypto.randomUUID();
  for (let i = 0; i < prepared.length; i++) {
    onProgress(i, prepared.length);
    const image = prepared[i];
    let res: Response;
    try {
      res = await fetch(`/api/schedule/renders/${renderSetId}/${imageSlot(i)}`, {
        method: "PUT",
        headers: { "Content-Type": image.contentType },
        body: image.blob,
      });
    } catch {
      await discardRenderSet(renderSetId);
      throw new Error(`Uploading image ${i + 1} failed: the network request didn't complete.`);
    }
    if (!res.ok) {
      const reason = await errorText(res);
      await discardRenderSet(renderSetId);
      throw new Error(`Uploading image ${i + 1} failed: ${reason}`);
    }
  }
  onProgress(prepared.length, prepared.length);
  return {
    renderSetId,
    images: prepared.map((p) => ({ filename: p.filename, contentType: p.contentType, altText: p.altText })),
  };
}

/** Best-effort removal of an uploaded set that no schedule ended up using. */
export async function discardRenderSet(renderSetId: string): Promise<void> {
  await fetch(`/api/schedule/renders/${renderSetId}`, { method: "DELETE" }).catch(() => {});
}
