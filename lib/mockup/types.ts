/**
 * DOM-free core types for the mockup compositor.
 *
 * Phase 0 of the migration (see memory `mockup-screen-migration`): the geometry,
 * compositing and tone logic ported from the standalone `mockup-atolyesi.html`
 * so the exact same code runs in the browser preview and on the server.
 *
 * All pixel work happens on a plain {@link Raster} — an RGBA byte buffer — never
 * a canvas. Adapters (client `<canvas>`, server `@napi-rs/canvas`) convert to and
 * from this shape.
 */

/** A point in normalised [0..1] template space (x, y). */
export type Pt = [number, number];

/**
 * A print area: four corners of a smart object's transform, normalised to the
 * template's [0..1] space, in the PSD's stored order
 * (top-left, top-right, bottom-right, bottom-left for an untransformed layer).
 */
export type Quad = [Pt, Pt, Pt, Pt];

/** Non-premultiplied RGBA, row-major, `data.length === width * height * 4`. */
export interface Raster {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

/** Canvas `globalCompositeOperation` values produced by the PSD blend-mode map. */
export type BlendMode =
  | "source-over"
  | "multiply"
  | "screen"
  | "overlay"
  | "darken"
  | "lighten"
  | "color-dodge"
  | "color-burn"
  | "hard-light"
  | "soft-light"
  | "difference"
  | "exclusion"
  | "lighter"
  | "hue"
  | "saturation"
  | "color"
  | "luminosity";

/**
 * A layer that sits above the lowest smart object in the PSD and must be
 * redrawn on top of the placed design (fold shadows, highlights, seams).
 * `data` is the layer's own RGBA at `w`×`h`, positioned at `x`,`y` in PSD pixels.
 */
export interface Overlay {
  data: Uint8ClampedArray;
  x: number;
  y: number;
  w: number;
  h: number;
  blend: BlendMode;
  /** 0..1 layer opacity. */
  alpha: number;
  /** PSD clipping-group flag. Carried for fidelity; not yet applied (matches the original). */
  clip: boolean;
  name: string;
}

export type Tone = "dark" | "light" | null;

/**
 * Per-template calibration. Mirrors the `calib[key]` object in the original
 * tool. Sliders are stored in their UI units (see field docs); the compositor
 * converts them.
 */
export interface Calibration {
  /** Print areas. Newer records use `qs`; `q` is the legacy single-area field. */
  qs?: Quad[];
  q?: Quad;
  /** Index of the active area within `qs`. */
  ai?: number;
  /** Fabric shading strength, 0..130 → used as `shade / 100`. */
  shade: number;
  /** Wrinkle displacement strength, 0..40. */
  disp: number;
  /** Wrinkle blur scale, 2..48. */
  dispR: number;
  /** Print size, 40..120 → used as `zoom / 100` (contain-fit multiplier). */
  zoom: number;
  /** Rotation in degrees, -180..180. Applied to the quad, not in `stampQuad`. */
  rot: number;
  /** Blend-If (underlying layer) black slider low/high, 0..255. */
  b1: number;
  b2: number;
  /** Blend-If (underlying layer) white slider low/high, 0..255. */
  w1: number;
  w2: number;
  /** Area → design index map for group mockups (per-area different design). */
  amap?: number[];
  /** Whether the corresponding `amap` entry was set by hand (vs auto tone match). */
  aset?: boolean[];
  /** Original quads / set flag captured on load, for "reset to template". */
  qs0?: Quad[];
  set0?: boolean;
  /** Whether the user has touched this calibration. */
  set?: boolean;
}

/** Minimal design descriptor the pairing logic needs. */
export interface DesignRef {
  tone: Tone;
}

/** Result of {@link measureTone}. */
export interface ToneReading {
  tone: Tone;
  /** Mean luminance 0..255 (rounded). */
  lum: number;
  /** Mean saturation 0..1 (2 dp). */
  sat: number;
  /** Palette colour name that was matched, when any. */
  matched: string;
  /** How the tone was decided: "ad" | "ölçüm" | "mürekkep". */
  src: string;
}

export const DEFAULT_QUAD: Quad = [
  [0.3, 0.3],
  [0.7, 0.3],
  [0.7, 0.68],
  [0.3, 0.68],
];
