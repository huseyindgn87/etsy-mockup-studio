import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { getEtsySession } from "@/lib/etsy/auth";
import { getSavedCalibration } from "@/lib/mockup/calibration-store";
import { parsePsd, PsdParseError, type PsdParseResult } from "@/lib/mockup/psd";
import { encodeRasterDataUrl } from "@/lib/mockup/server";
import { measureTone } from "@/lib/mockup/tone";
import { DEFAULT_QUAD, type Calibration, type Quad } from "@/lib/mockup/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Reject uploads above this before reading them into memory. */
const MAX_PSD_BYTES = 80 * 1024 * 1024;

/** Slider defaults for a fresh calibration — mirrors the tool's `ensureCalib`. */
const CALIBRATION_DEFAULTS = {
  shade: 15,
  disp: 10,
  dispR: 12,
  zoom: 100,
  rot: 0,
  b1: 0,
  b2: 0,
  w1: 255,
  w2: 255,
} as const;

const cloneQuad = (q: Quad): Quad => q.map((p) => [...p]) as Quad;

/**
 * Seed a calibration from the parsed print areas. With areas it is marked `set`
 * (the PSD told us where the design goes); without, it is the untouched default
 * over {@link DEFAULT_QUAD}, matching what the tool does on load.
 */
function suggestCalibration(quads: Quad[]): Calibration {
  if (!quads.length) {
    const d = cloneQuad(DEFAULT_QUAD);
    return {
      ...CALIBRATION_DEFAULTS,
      q: d,
      qs: [cloneQuad(d)],
      ai: 0,
      qs0: [cloneQuad(d)],
      set0: false,
      set: false,
    };
  }
  return {
    ...CALIBRATION_DEFAULTS,
    q: quads[0],
    qs: quads,
    ai: 0,
    qs0: quads.map(cloneQuad),
    set0: true,
    set: true,
  };
}

/**
 * Parse an uploaded `.psd` mockup template.
 *
 * `POST /api/mockups/psd` — `multipart/form-data`, field `psd`. Returns the PSD's
 * composite as a PNG data URL, every readable print area (normalised quads) with
 * its layer name, the overlay layers above the lowest area (each its own PNG), a
 * garment tone reading, a ready-to-edit calibration seeded from the areas, and a
 * content hash (sha256 of the PSD's bytes) plus any calibration already saved
 * under it — `filename|size` isn't used as a key so renaming a template doesn't
 * lose its calibration. The geometry / compositing math stays in `lib/mockup`;
 * this only decodes.
 */
export async function POST(request: Request) {
  const session = await getEtsySession();
  if (!session) {
    return NextResponse.json({ error: "Not connected to Etsy." }, { status: 401 });
  }

  let file: File;
  try {
    const field = (await request.formData()).get("psd");
    if (!(field instanceof File)) {
      return NextResponse.json({ error: 'Missing "psd" file field.' }, { status: 400 });
    }
    file = field;
  } catch {
    return NextResponse.json({ error: "Expected multipart/form-data." }, { status: 400 });
  }

  if (file.size > MAX_PSD_BYTES) {
    const mb = Math.floor(MAX_PSD_BYTES / 1024 / 1024);
    return NextResponse.json({ error: `PSD too large (max ${mb} MB).` }, { status: 413 });
  }

  const buf = await file.arrayBuffer();
  const contentHash = createHash("sha256").update(new Uint8Array(buf)).digest("hex");

  let parsed: PsdParseResult;
  try {
    parsed = parsePsd(buf);
  } catch (err) {
    if (err instanceof PsdParseError) {
      return NextResponse.json({ error: err.message }, { status: 422 });
    }
    const message = err instanceof Error ? err.message : "PSD parse failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }

  const [composite, overlays] = await Promise.all([
    encodeRasterDataUrl(parsed.composite),
    Promise.all(
      parsed.overlays.map(async (ov) => ({
        x: ov.x,
        y: ov.y,
        w: ov.w,
        h: ov.h,
        blend: ov.blend,
        alpha: ov.alpha,
        clip: ov.clip,
        name: ov.name,
        image: await encodeRasterDataUrl({
          data: ov.data,
          width: ov.w,
          height: ov.h,
        }),
      })),
    ),
  ]);

  const tone = measureTone(parsed.composite, { isMock: true, name: file.name });
  const savedCalibration = await getSavedCalibration(session.userId, contentHash).catch(
    () => null, // a DB hiccup shouldn't block the parse — the UI falls back to suggestedCalibration
  );

  return NextResponse.json({
    psd: { width: parsed.width, height: parsed.height },
    contentHash,
    composite,
    areas: parsed.quads,
    areaNames: parsed.areaNames,
    layerName: parsed.layerName,
    smartCount: parsed.smartCount,
    overlays,
    tone,
    suggestedCalibration: suggestCalibration(parsed.quads),
    savedCalibration,
  });
}
