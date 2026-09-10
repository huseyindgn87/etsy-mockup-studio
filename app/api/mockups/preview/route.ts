import { NextResponse } from "next/server";
import { getEtsySession } from "@/lib/etsy/auth";
import { compose } from "@/lib/mockup/compose";
import { quadList } from "@/lib/mockup/geometry";
import { decodeToRaster, encodeRaster } from "@/lib/mockup/server";
import {
  DEFAULT_QUAD,
  type BlendMode,
  type Calibration,
  type Overlay,
  type Quad,
  type Raster,
} from "@/lib/mockup/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_IMAGE_BYTES = 40 * 1024 * 1024;
const MAX_TOTAL_BYTES = 120 * 1024 * 1024;
const MAX_DIMENSION = 8000;

const BLEND_MODES = new Set<string>([
  "source-over",
  "multiply",
  "screen",
  "overlay",
  "darken",
  "lighten",
  "color-dodge",
  "color-burn",
  "hard-light",
  "soft-light",
  "difference",
  "exclusion",
  "lighter",
  "hue",
  "saturation",
  "color",
  "luminosity",
]);

interface OverlayMeta {
  x?: number;
  y?: number;
  blend?: string;
  alpha?: number;
  clip?: boolean;
  name?: string;
}

interface PreviewPayload {
  calibration?: unknown;
  overlays?: OverlayMeta[];
  width?: number;
  height?: number;
  format?: "png" | "jpeg";
  quality?: number;
}

const num = (v: unknown, fallback: number): number =>
  typeof v === "number" && Number.isFinite(v) ? v : fallback;

const clamp = (v: number, lo: number, hi: number): number =>
  Math.min(hi, Math.max(lo, v));

const cloneQuad = (q: Quad): Quad => q.map((p) => [...p]) as Quad;

/** A quad is 4 points of 2 finite numbers each. */
function toQuad(v: unknown): Quad | null {
  if (!Array.isArray(v) || v.length !== 4) return null;
  const out: number[][] = [];
  for (const p of v) {
    if (!Array.isArray(p) || p.length !== 2) return null;
    const x = Number(p[0]);
    const y = Number(p[1]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    out.push([x, y]);
  }
  return out as Quad;
}

/**
 * Coerce untrusted JSON into a valid {@link Calibration}. Unknown / malformed
 * fields fall back to the tool's defaults so `compose` never sees garbage.
 */
function coerceCalibration(raw: unknown): Calibration {
  const r = (raw ?? {}) as Record<string, unknown>;

  const qs = Array.isArray(r.qs)
    ? r.qs.map(toQuad).filter((q): q is Quad => q !== null)
    : [];
  const single = toQuad(r.q);
  const areas = qs.length ? qs : single ? [single] : [cloneQuad(DEFAULT_QUAD)];

  const aiRaw = Math.trunc(num(r.ai, 0));
  const ai = aiRaw >= 0 && aiRaw < areas.length ? aiRaw : 0;

  return {
    qs: areas,
    q: areas[0],
    ai,
    shade: clamp(num(r.shade, 15), 0, 130),
    disp: clamp(num(r.disp, 10), 0, 40),
    dispR: clamp(num(r.dispR, 12), 2, 48),
    zoom: clamp(num(r.zoom, 100), 40, 120),
    rot: clamp(num(r.rot, 0), -180, 180),
    b1: clamp(Math.trunc(num(r.b1, 0)), 0, 255),
    b2: clamp(Math.trunc(num(r.b2, 0)), 0, 255),
    w1: clamp(Math.trunc(num(r.w1, 255)), 0, 255),
    w2: clamp(Math.trunc(num(r.w2, 255)), 0, 255),
  };
}

function normalizeBlend(v: unknown): BlendMode {
  return typeof v === "string" && BLEND_MODES.has(v) ? (v as BlendMode) : "source-over";
}

/**
 * Composite one mockup with a design and return a single flattened image.
 *
 * `POST /api/mockups/preview` — `multipart/form-data`:
 *   - `mockup`   (file, required)  the composite to print onto
 *   - `design`   (file)            applied to every print area
 *   - `designs`  (file, repeated)  per-area override; `designs[i]` → area i,
 *                                  a missing / empty slot falls back to `design`
 *   - `overlays` (file, repeated)  overlay layer images, in `payload.overlays` order
 *   - `payload`  (json string)     { calibration, overlays?, width?, height?,
 *                                    format?: "png"|"jpeg", quality? }
 *
 * Returns the image bytes (`image/png` or `image/jpeg`). This is the server-side
 * single render that the batch endpoint (Phase 3) will fan out across a worker
 * pool; the geometry / compositing math is the shared `lib/mockup` core, so the
 * output matches the in-browser preview pixel-for-pixel.
 */
export async function POST(request: Request) {
  if (!(await getEtsySession())) {
    return NextResponse.json({ error: "Not connected to Etsy." }, { status: 401 });
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: "Expected multipart/form-data." }, { status: 400 });
  }

  const mockupField = form.get("mockup");
  if (!(mockupField instanceof File)) {
    return NextResponse.json({ error: 'Missing "mockup" file field.' }, { status: 400 });
  }

  const designField = form.get("design");
  const designFiles = form.getAll("designs");
  const overlayFiles = form.getAll("overlays");

  const allFiles: File[] = [
    mockupField,
    ...(designField instanceof File ? [designField] : []),
    ...designFiles.filter((f): f is File => f instanceof File),
    ...overlayFiles.filter((f): f is File => f instanceof File),
  ];
  let total = 0;
  for (const f of allFiles) {
    if (f.size > MAX_IMAGE_BYTES) {
      const mb = Math.floor(MAX_IMAGE_BYTES / 1024 / 1024);
      return NextResponse.json({ error: `Image too large (max ${mb} MB each).` }, { status: 413 });
    }
    total += f.size;
  }
  if (total > MAX_TOTAL_BYTES) {
    return NextResponse.json({ error: "Upload too large." }, { status: 413 });
  }

  let payload: PreviewPayload;
  try {
    const raw = form.get("payload");
    payload = raw ? (JSON.parse(String(raw)) as PreviewPayload) : {};
  } catch {
    return NextResponse.json({ error: '"payload" is not valid JSON.' }, { status: 400 });
  }

  const format: "png" | "jpeg" = payload.format === "jpeg" ? "jpeg" : "png";
  const quality = clamp(Math.trunc(num(payload.quality, 92)), 1, 100);
  const calibration = coerceCalibration(payload.calibration);
  const overlayMeta = Array.isArray(payload.overlays) ? payload.overlays : [];

  const overlayImageFiles = overlayFiles.filter((f): f is File => f instanceof File);
  if (overlayMeta.length !== overlayImageFiles.length) {
    return NextResponse.json(
      { error: "`payload.overlays` length must match the number of `overlays` files." },
      { status: 400 },
    );
  }

  let mock: Raster;
  let design: Raster | null;
  let perArea: (Raster | null)[] | null;
  let overlays: Overlay[];
  try {
    const bufOf = async (f: File) => Buffer.from(await f.arrayBuffer());

    mock = await decodeToRaster(await bufOf(mockupField));

    design =
      designField instanceof File && designField.size
        ? await decodeToRaster(await bufOf(designField))
        : null;

    perArea = designFiles.length
      ? await Promise.all(
          designFiles.map(async (f) =>
            f instanceof File && f.size ? decodeToRaster(await bufOf(f)) : null,
          ),
        )
      : null;

    const overlayRasters = await Promise.all(
      overlayImageFiles.map(async (f) => decodeToRaster(await bufOf(f))),
    );
    overlays = overlayRasters.map((rr, i) => {
      const m = overlayMeta[i] ?? {};
      return {
        data: rr.data,
        x: Math.round(num(m.x, 0)),
        y: Math.round(num(m.y, 0)),
        w: rr.width,
        h: rr.height,
        blend: normalizeBlend(m.blend),
        alpha: clamp(num(m.alpha, 1), 0, 1),
        clip: !!m.clip,
        name: typeof m.name === "string" ? m.name : "",
      };
    });
  } catch {
    return NextResponse.json({ error: "Could not decode one of the images." }, { status: 422 });
  }

  const W = clamp(Math.round(num(payload.width, mock.width)), 1, MAX_DIMENSION);
  const H = clamp(Math.round(num(payload.height, mock.height)), 1, MAX_DIMENSION);

  // Drop per-area entries beyond the calibration's area count so `compose`'s
  // `perArea[i]` lines up with `quadList(calibration)[i]`.
  const areaCount = quadList(calibration).length;
  const perAreaTrimmed =
    perArea && perArea.some(Boolean) ? perArea.slice(0, areaCount) : null;

  let out: Raster;
  try {
    out = compose(
      { mock, design, perArea: perAreaTrimmed, calibration, overlays },
      W,
      H,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Compose failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }

  const body = await encodeRaster(out, { format, quality });
  return new Response(new Uint8Array(body), {
    status: 200,
    headers: {
      "Content-Type": format === "jpeg" ? "image/jpeg" : "image/png",
      "Content-Length": String(body.length),
      "Cache-Control": "no-store",
    },
  });
}
