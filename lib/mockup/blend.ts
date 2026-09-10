/**
 * Canvas blend modes as pure functions (W3C Compositing and Blending Level 1),
 * so PSD overlay layers composite identically without a `<canvas>`.
 *
 * The original tool relied on `ctx.globalCompositeOperation` + `drawImage`;
 * `PSD_BLEND` below is the same 8BIM-key → mode map it used.
 */

import type { BlendMode, Overlay, Raster } from "./types";

/** PSD layer blend key → canvas composite op. Verbatim from `mockup-atolyesi.html`. */
export const PSD_BLEND: Record<string, BlendMode> = {
  norm: "source-over",
  "mul ": "multiply",
  scrn: "screen",
  over: "overlay",
  dark: "darken",
  lite: "lighten",
  sLit: "soft-light",
  hLit: "hard-light",
  diff: "difference",
  lddg: "lighter",
  "div ": "color-dodge",
  idiv: "color-burn",
  "hue ": "hue",
  "sat ": "saturation",
  colr: "color",
  "lum ": "luminosity",
};

type Sep = (cb: number, cs: number) => number;

const multiply: Sep = (cb, cs) => cb * cs;
const screen: Sep = (cb, cs) => cb + cs - cb * cs;
const hardLight: Sep = (cb, cs) =>
  cs <= 0.5 ? multiply(cb, 2 * cs) : screen(cb, 2 * cs - 1);
const softLight: Sep = (cb, cs) => {
  if (cs <= 0.5) return cb - (1 - 2 * cs) * cb * (1 - cb);
  const d = cb <= 0.25 ? ((16 * cb - 12) * cb + 4) * cb : Math.sqrt(cb);
  return cb + (2 * cs - 1) * (d - cb);
};

const SEPARABLE: Partial<Record<BlendMode, Sep>> = {
  "source-over": (_cb, cs) => cs,
  multiply,
  screen,
  overlay: (cb, cs) => hardLight(cs, cb),
  darken: (cb, cs) => Math.min(cb, cs),
  lighten: (cb, cs) => Math.max(cb, cs),
  "color-dodge": (cb, cs) =>
    cb === 0 ? 0 : cs === 1 ? 1 : Math.min(1, cb / (1 - cs)),
  "color-burn": (cb, cs) =>
    cb === 1 ? 1 : cs === 0 ? 0 : 1 - Math.min(1, (1 - cb) / cs),
  "hard-light": hardLight,
  "soft-light": softLight,
  difference: (cb, cs) => Math.abs(cb - cs),
  exclusion: (cb, cs) => cb + cs - 2 * cb * cs,
};

/* ---- non-separable (hue / saturation / color / luminosity) ---- */
type Triple = [number, number, number];
const lum = (c: Triple) => 0.3 * c[0] + 0.59 * c[1] + 0.11 * c[2];
const sat = (c: Triple) => Math.max(...c) - Math.min(...c);

function clipColor(c: Triple): Triple {
  const l = lum(c);
  const n = Math.min(...c);
  const x = Math.max(...c);
  let [r, g, b] = c;
  if (n < 0) {
    r = l + ((r - l) * l) / (l - n);
    g = l + ((g - l) * l) / (l - n);
    b = l + ((b - l) * l) / (l - n);
  }
  if (x > 1) {
    r = l + ((r - l) * (1 - l)) / (x - l);
    g = l + ((g - l) * (1 - l)) / (x - l);
    b = l + ((b - l) * (1 - l)) / (x - l);
  }
  return [r, g, b];
}

function setLum(c: Triple, l: number): Triple {
  const d = l - lum(c);
  return clipColor([c[0] + d, c[1] + d, c[2] + d]);
}

function setSat(c: Triple, s: number): Triple {
  const idx = [0, 1, 2].sort((a, b) => c[a] - c[b]);
  const [lo, mid, hi] = idx;
  const out: Triple = [0, 0, 0];
  if (c[hi] > c[lo]) {
    out[mid] = ((c[mid] - c[lo]) * s) / (c[hi] - c[lo]);
    out[hi] = s;
  }
  out[lo] = 0;
  return out;
}

function nonSeparable(mode: BlendMode, cb: Triple, cs: Triple): Triple {
  switch (mode) {
    case "hue":
      return setLum(setSat(cs, sat(cb)), lum(cb));
    case "saturation":
      return setLum(setSat(cb, sat(cs)), lum(cb));
    case "color":
      return setLum(cs, lum(cb));
    case "luminosity":
      return setLum(cb, lum(cs));
    default:
      return cs;
  }
}

const NON_SEP = new Set<BlendMode>(["hue", "saturation", "color", "luminosity"]);

/**
 * Composite one source pixel (`sr,sg,sb` 0..255, `sa` 0..1) onto the backdrop
 * stored at `data[i..i+3]`, in place, using `mode`.
 */
export function compositePixel(
  data: Uint8ClampedArray,
  i: number,
  sr: number,
  sg: number,
  sb: number,
  sa: number,
  mode: BlendMode,
): void {
  if (sa <= 0) return;
  const ab = data[i + 3] / 255;
  const br = data[i] / 255;
  const bg = data[i + 1] / 255;
  const bb = data[i + 2] / 255;

  if (mode === "lighter") {
    const ao = Math.min(1, sa + ab);
    if (ao <= 0) return;
    const r = ((sr / 255) * sa + br * ab) / ao;
    const g = ((sg / 255) * sa + bg * ab) / ao;
    const b = ((sb / 255) * sa + bb * ab) / ao;
    data[i] = r * 255;
    data[i + 1] = g * 255;
    data[i + 2] = b * 255;
    data[i + 3] = ao * 255;
    return;
  }

  let cr = sr / 255;
  let cg = sg / 255;
  let cbl = sb / 255;
  if (NON_SEP.has(mode)) {
    const t = nonSeparable(mode, [br, bg, bb], [cr, cg, cbl]);
    cr = t[0];
    cg = t[1];
    cbl = t[2];
  } else {
    const f = SEPARABLE[mode] ?? SEPARABLE["source-over"]!;
    cr = f(br, cr);
    cg = f(bg, cg);
    cbl = f(bb, cbl);
  }
  // mix the blended colour by the backdrop's alpha, then source-over
  const mr = (1 - ab) * (sr / 255) + ab * cr;
  const mg = (1 - ab) * (sg / 255) + ab * cg;
  const mb = (1 - ab) * (sb / 255) + ab * cbl;
  const ao = sa + ab * (1 - sa);
  if (ao <= 0) {
    data[i + 3] = 0;
    return;
  }
  data[i] = ((mr * sa + br * ab * (1 - sa)) / ao) * 255;
  data[i + 1] = ((mg * sa + bg * ab * (1 - sa)) / ao) * 255;
  data[i + 2] = ((mb * sa + bb * ab * (1 - sa)) / ao) * 255;
  data[i + 3] = ao * 255;
}

/**
 * Draw the PSD overlay layers on top of `dest` (already at W×H), scaling from
 * PSD pixel space by (W/psdW, H/psdH). Mirrors the original `drawOverlays()`.
 */
export function drawOverlays(
  dest: Raster,
  overlays: Overlay[] | undefined,
  W: number,
  H: number,
  psdW: number,
  psdH: number,
): void {
  if (!overlays || !overlays.length) return;
  const sx = W / psdW;
  const sy = H / psdH;
  for (const ov of overlays) {
    const dx = ov.x * sx;
    const dy = ov.y * sy;
    const dw = ov.w * sx;
    const dh = ov.h * sy;
    const x0 = Math.max(0, Math.floor(dx));
    const y0 = Math.max(0, Math.floor(dy));
    const x1 = Math.min(W, Math.ceil(dx + dw));
    const y1 = Math.min(H, Math.ceil(dy + dh));
    for (let y = y0; y < y1; y++) {
      const oy = Math.min(ov.h - 1, Math.max(0, ((y + 0.5 - dy) / dh) * ov.h - 0.5));
      const iy = oy | 0;
      for (let x = x0; x < x1; x++) {
        const ox = Math.min(ov.w - 1, Math.max(0, ((x + 0.5 - dx) / dw) * ov.w - 0.5));
        const ix = ox | 0;
        const s = (iy * ov.w + ix) * 4;
        const a = (ov.data[s + 3] / 255) * ov.alpha;
        if (a <= 0) continue;
        compositePixel(
          dest.data,
          (y * W + x) * 4,
          ov.data[s],
          ov.data[s + 1],
          ov.data[s + 2],
          a,
          ov.blend,
        );
      }
    }
  }
}
