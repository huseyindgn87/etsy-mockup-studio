/**
 * Batch render worker: one job = decode inputs → `compose` → encode.
 *
 * Runs as a native-Node `.ts` worker thread (see `render-worker-bootstrap.mjs`).
 * The compositing is the shared `lib/mockup` core, so a batch render is the same
 * pixels as the `/api/mockups/preview` render and the in-browser preview.
 */

import { parentPort } from "node:worker_threads";
import sharp from "sharp";
import { compose } from "./compose";
import { searchJpegQuality } from "./encode-search";
import type { RenderJobInput, RenderJobResult } from "./render-types";
import { decodeToRaster } from "./server";
import type { Overlay } from "./types";

if (!parentPort) {
  throw new Error("render.worker.ts must be run as a worker thread");
}
const port = parentPort;

interface Incoming extends RenderJobInput {
  id: number;
}

const toArrayBuffer = (b: Buffer): ArrayBuffer =>
  b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;

async function render(job: RenderJobInput): Promise<RenderJobResult> {
  const mock = await decodeToRaster(Buffer.from(job.mock));
  const design = job.design ? await decodeToRaster(Buffer.from(job.design)) : null;
  const perArea = job.areaDesigns
    ? await Promise.all(
        job.areaDesigns.map((b) => (b ? decodeToRaster(Buffer.from(b)) : null)),
      )
    : null;

  const overlayRasters = await Promise.all(
    job.overlays.map((o) => decodeToRaster(Buffer.from(o.bytes))),
  );
  const overlays: Overlay[] = overlayRasters.map((r, i) => ({
    data: r.data,
    x: job.overlays[i].x,
    y: job.overlays[i].y,
    w: r.width,
    h: r.height,
    blend: job.overlays[i].blend,
    alpha: job.overlays[i].alpha,
    clip: job.overlays[i].clip,
    name: job.overlays[i].name,
  }));

  const W = job.width && job.width > 0 ? Math.round(job.width) : mock.width;
  const H = job.height && job.height > 0 ? Math.round(job.height) : mock.height;

  const out = compose({ mock, design, perArea, calibration: job.calibration, overlays }, W, H);
  const raw = Buffer.from(out.data.buffer, out.data.byteOffset, out.data.byteLength);
  const rawOpts = { raw: { width: out.width, height: out.height, channels: 4 } } as const;

  if (job.format === "png") {
    const png = await sharp(raw, rawOpts).png().toBuffer();
    return { ok: true, bytes: toArrayBuffer(png), ext: "png", size: png.length };
  }

  const flat = sharp(raw, rawOpts).flatten({ background: { r: 255, g: 255, b: 255 } });
  const search = await searchJpegQuality(
    async (q) => {
      const b = await flat.clone().jpeg({ quality: Math.round(q * 100) }).toBuffer();
      return b.length;
    },
    { min: job.targetMin, max: job.targetMax },
  );
  const jpg = await flat
    .clone()
    .jpeg({ quality: Math.round(search.quality * 100) })
    .toBuffer();
  return { ok: true, bytes: toArrayBuffer(jpg), ext: "jpg", size: jpg.length };
}

port.on("message", (job: Incoming) => {
  render(job)
    .then((result) => {
      const transfer = result.ok ? [result.bytes] : [];
      port.postMessage({ id: job.id, ...result }, transfer);
    })
    .catch((err: unknown) => {
      port.postMessage({
        id: job?.id ?? -1,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    });
});
