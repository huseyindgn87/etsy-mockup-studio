/**
 * Garment / ink tone classification, ported from `mockup-atolyesi.html`.
 *
 * Decides whether a mockup is a dark or light product and whether a design is
 * light or dark ink, so a white design pairs with a dark garment and vice
 * versa. Also assigns designs to individual print areas of a group mockup.
 *
 * Canvas sampling in the original is replaced with plain-buffer downscaling
 * ({@link downscaleSquare} / {@link averageRGB}).
 */

import { averageRGB, downscaleSquare } from "./raster";
import {
  type Calibration,
  type DesignRef,
  type Quad,
  type Raster,
  type Tone,
  type ToneReading,
} from "./types";

/**
 * Product colour swatch: `[name, r, g, b, tone]`. `tone` is how the printed
 * label reads on the box — white label ⇒ dark product, black label ⇒ light.
 * Copied verbatim (Gildan/Comfort Colors chart measured from box art).
 */
export const COLORS: readonly [string, number, number, number, Tone][] = [
  ["Fan Charcoal Heather", 69, 72, 75, "dark"],
  ["Heather Dark Maroon", 154, 106, 116, "dark"],
  ["Heather Scarlet Red", 197, 89, 97, "dark"],
  ["Antique Cherry Red", 169, 25, 42, "dark"],
  ["Heather Dark Green", 99, 119, 103, "dark"],
  ["Heather Deep Royal", 87, 106, 161, "dark"],
  ["Heather Dark Navy", 105, 108, 130, "dark"],
  ["Graphite Heather", 155, 154, 159, "dark"],
  ["Dark Chocolate", 56, 48, 42, "dark"],
  ["Fan Dark Green", 15, 64, 48, "dark"],
  ["Fan Deep Royal", 31, 52, 114, "dark"],
  ["Military Green", 118, 111, 93, "dark"],
  ["Carolina Blue", 109, 149, 207, "dark"],
  ["Safety Orange", 255, 101, 20, "dark"],
  ["Cardinal Red", 121, 26, 43, "dark"],
  ["Dark Heather", 93, 96, 103, "dark"],
  ["Safety Green", 233, 246, 115, "light"],
  ["Indigo Blue", 82, 103, 129, "dark"],
  ["Irish Green", 5, 132, 72, "dark"],
  ["Safety Pink", 255, 105, 141, "dark"],
  ["Cherry Red", 204, 26, 62, "dark"],
  ["Light Blue", 171, 197, 229, "light"],
  ["Light Pink", 249, 198, 221, "light"],
  ["Sport Grey", 185, 185, 185, "dark"],
  ["Heliconia", 218, 51, 111, "dark"],
  ["Neon Blue", 18, 86, 173, "dark"],
  ["Charcoal", 87, 87, 92, "dark"],
  ["Sapphire", 6, 133, 190, "dark"],
  ["Forest", 45, 51, 44, "dark"],
  ["Garnet", 91, 25, 34, "dark"],
  ["Maroon", 94, 41, 55, "dark"],
  ["Orange", 254, 75, 39, "dark"],
  ["Purple", 64, 47, 99, "dark"],
  ["White", 240, 240, 240, "light"],
  ["Black", 36, 35, 39, "dark"],
  ["Royal", 55, 100, 179, "dark"],
  ["Gold", 255, 160, 32, "light"],
  ["Navy", 39, 42, 56, "dark"],
  ["Sand", 200, 184, 164, "light"],
  ["Ash", 204, 200, 197, "light"],
  ["Red", 196, 29, 45, "dark"],
  ["White", 246, 246, 246, "light"],
  ["Black", 29, 32, 37, "dark"],
  ["Antique Cherry Red", 152, 21, 42, "dark"],
  ["Antique Heliconia", 170, 54, 112, "dark"],
  ["Antique Sapphire", 4, 93, 133, "dark"],
  ["Azalea", 253, 123, 154, "light"],
  ["Cardinal Red", 138, 30, 50, "dark"],
  ["Carolina Blue", 131, 169, 226, "dark"],
  ["Charcoal", 81, 77, 78, "dark"],
  ["Cherry Red", 174, 27, 55, "dark"],
  ["Coral Silk", 255, 101, 98, "dark"],
  ["Cornsilk", 209, 200, 116, "light"],
  ["Daisy", 255, 196, 37, "light"],
  ["Dark Chocolate", 66, 57, 54, "dark"],
  ["Dark Heather", 84, 89, 97, "dark"],
  ["Desert Clay", 184, 107, 108, "dark"],
  ["Fan Candy Pink", 235, 149, 176, "dark"],
  ["Fan Dark Green", 15, 63, 47, "dark"],
  ["Fan Dark Purple", 43, 29, 65, "dark"],
  ["Fan Deep Royal", 21, 39, 101, "dark"],
  ["Fan Marine Green", 13, 53, 53, "dark"],
  ["Fan Texas Orange", 153, 69, 40, "dark"],
  ["Forest", 37, 53, 44, "dark"],
  ["Garnet", 104, 17, 39, "dark"],
  ["Gold", 255, 185, 8, "light"],
  ["Graphite Heather", 129, 124, 130, "dark"],
  ["Heather Berry", 209, 87, 141, "dark"],
  ["Heather Cardinal Red", 197, 89, 104, "dark"],
  ["Heather Dark Grey", 88, 88, 88, "dark"],
  ["Heather Galapagos Blue", 62, 156, 178, "dark"],
  ["Heather Heliconia", 254, 96, 147, "dark"],
  ["Heather Indigo", 128, 154, 179, "dark"],
  ["Heather Irish Green", 9, 142, 92, "dark"],
  ["Heather Maroon", 101, 51, 63, "dark"],
  ["Heather Military Green", 120, 123, 104, "dark"],
  ["Heather Navy", 71, 74, 90, "dark"],
  ["Heather Oatmeal", 222, 208, 190, "light"],
  ["Heather Orange", 254, 115, 83, "light"],
  ["Heather Purple", 98, 83, 134, "dark"],
  ["Heather Radiant Orchid", 221, 134, 187, "dark"],
  ["Heather Red", 214, 66, 89, "dark"],
  ["Heather Royal", 101, 143, 212, "dark"],
  ["Heather Sapphire", 61, 157, 193, "dark"],
  ["Heliconia", 250, 68, 125, "dark"],
  ["Ice Grey", 224, 213, 211, "light"],
  ["Indigo Blue", 78, 104, 131, "dark"],
  ["Iris", 75, 130, 195, "dark"],
  ["Irish Green", 4, 144, 83, "dark"],
  ["Jade Dome", 2, 152, 161, "dark"],
  ["Kelly Green", 1, 174, 128, "dark"],
  ["Kiwi", 132, 166, 91, "light"],
  ["Light Blue", 158, 187, 217, "light"],
  ["Light Pink", 237, 198, 214, "light"],
  ["Lime", 149, 221, 101, "light"],
  ["Maroon", 84, 30, 44, "dark"],
  ["Metro Blue", 65, 75, 122, "dark"],
  ["Military Green", 86, 86, 69, "dark"],
  ["Mint Green", 175, 230, 180, "light"],
  ["Natural", 223, 206, 185, "light"],
  ["Navy", 33, 42, 60, "dark"],
  ["Neon Blue", 35, 75, 161, "dark"],
  ["Off White", 242, 234, 213, "light"],
  ["Orange", 255, 91, 56, "dark"],
  ["Paragon", 182, 150, 160, "dark"],
  ["Pistachio", 202, 216, 175, "light"],
  ["Prairie Dust", 135, 121, 94, "dark"],
  ["Purple", 68, 41, 110, "dark"],
  ["Red", 206, 36, 53, "dark"],
  ["Royal", 23, 79, 163, "dark"],
  ["Sage", 154, 169, 144, "dark"],
  ["Sand", 194, 176, 160, "light"],
  ["Sapphire", 3, 130, 184, "dark"],
  ["Sky", 174, 224, 248, "light"],
  ["Sport Grey", 149, 149, 149, "dark"],
  ["Stone Blue", 144, 162, 180, "dark"],
  ["Tropical Blue", 25, 120, 135, "dark"],
  ["Turf Green", 7, 115, 65, "dark"],
];

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[_\-.]+/g, " ")
    .replace(/\s+/g, " ");

const DARKWORD = /(black|siyah|dark ink|koyu)/i;
const LIGHTWORD = /(white|beyaz|light ink|acik|açık)/i;

/** Match a colour name inside a filename. */
export function colorFromName(fname: string): { nm: string; tone: Tone } | null {
  const n = " " + norm(fname) + " ";
  for (const [nm, , , , tone] of COLORS) {
    if (n.includes(" " + norm(nm) + " ") || n.includes(norm(nm).replace(/ /g, ""))) {
      return { nm, tone };
    }
  }
  return null;
}

/** Nearest swatch to an RGB triple (squared distance). */
export function colorFromRGB(
  R: number,
  G: number,
  B: number,
): { nm: string; tone: Tone; dist: number } {
  let best = { nm: "", tone: null as Tone, dist: 0 };
  let bd = 1e9;
  for (const [nm, r, g, b, tone] of COLORS) {
    const d = (R - r) * (R - r) + (G - g) * (G - g) + (B - b) * (B - b);
    if (d < bd) {
      bd = d;
      best = { nm, tone, dist: Math.round(Math.sqrt(d)) };
    }
  }
  return best;
}

/**
 * Classify a raster's tone. `isMock` samples only the centre 40% (the garment)
 * and matches against the swatch chart; otherwise it's an ink decision from
 * luminance plus filename hints. Same result shape as the original.
 */
export function measureTone(
  src: Raster,
  opts: { isMock: boolean; name: string },
): ToneReading {
  const S = 64;
  const D = downscaleSquare(src, S);
  let sl = 0;
  let ss = 0;
  let n = 0;
  let sR = 0;
  let sG = 0;
  let sB = 0;
  for (let i = 0; i < S * S; i++) {
    const o = i * 4;
    const A = D[o + 3];
    if (A < 40) continue;
    if (opts.isMock) {
      const px = i % S;
      const py = (i / S) | 0;
      if (px < S * 0.3 || px > S * 0.7 || py < S * 0.3 || py > S * 0.7) continue;
    }
    const R = D[o];
    const G = D[o + 1];
    const B = D[o + 2];
    const mx = Math.max(R, G, B);
    const mn = Math.min(R, G, B);
    sl += 0.299 * R + 0.587 * G + 0.114 * B;
    ss += mx ? (mx - mn) / mx : 0;
    sR += R;
    sG += G;
    sB += B;
    n++;
  }
  if (!n) return { tone: null, lum: 0, sat: 0, matched: "", src: "" };
  const lum = sl / n;
  const sat = ss / n;
  let tone: Tone = null;
  let decidedBy = "";
  let matched = "";

  if (opts.isMock) {
    const byName = colorFromName(opts.name);
    if (byName) {
      tone = byName.tone;
      matched = byName.nm;
      decidedBy = "ad";
    } else {
      const m = colorFromRGB(sR / n, sG / n, sB / n);
      tone = m.tone;
      matched = m.nm;
      decidedBy = "ölçüm";
    }
  } else {
    tone = lum > 150 ? "light" : lum < 110 ? "dark" : null;
    if (DARKWORD.test(opts.name) && !LIGHTWORD.test(opts.name)) tone = "dark";
    else if (LIGHTWORD.test(opts.name) && !DARKWORD.test(opts.name)) tone = "light";
    decidedBy = "mürekkep";
  }
  return {
    tone,
    lum: Math.round(lum),
    sat: +sat.toFixed(2),
    matched,
    src: decidedBy,
  };
}

/** Fabric colour under a print area (centroid ± 28% box), matched to a swatch. */
export function areaTone(
  mock: Raster,
  area: Quad,
): { tone: Tone; nm: string } | null {
  const W = mock.width;
  const H = mock.height;
  const xs = area.map((pt) => pt[0] * W);
  const ys = area.map((pt) => pt[1] * H);
  const cx = (xs[0] + xs[1] + xs[2] + xs[3]) / 4;
  const cy = (ys[0] + ys[1] + ys[2] + ys[3]) / 4;
  const hw = Math.max(4, (Math.max(...xs) - Math.min(...xs)) * 0.28);
  const hh = Math.max(4, (Math.max(...ys) - Math.min(...ys)) * 0.28);
  const { r, g, b, n } = averageRGB(mock, cx - hw, cy - hh, hw * 2, hh * 2);
  if (!n) return null;
  const mt = colorFromRGB(r, g, b);
  return { tone: mt.tone, nm: mt.nm };
}

/** White (light) design → dark garment, and vice versa. Unknowns never excluded. */
export function fits(m: DesignRef, d: DesignRef, pairAuto: boolean): boolean {
  if (!pairAuto) return true;
  if (!m.tone || !d.tone) return true;
  return m.tone !== d.tone;
}

/** Design vs a specific print area's fabric tone. */
export function fitsArea(
  at: { tone: Tone } | null,
  d: DesignRef,
): boolean {
  if (!at || !at.tone || !d.tone) return true;
  return d.tone !== at.tone;
}

/**
 * Area → design index. Hand-set entries (`c.aset[i]`) are kept; the rest are
 * filled by tone match, then any unused design, then a tone-matching repeat,
 * then design 0. Mutates and returns `c.amap`. Ported from `assignMap()`.
 */
export function assignMap(
  c: Calibration,
  areas: Quad[],
  designs: DesignRef[],
  areaToneOf: (area: Quad) => { tone: Tone } | null,
): number[] {
  if (!Array.isArray(c.amap)) c.amap = [];
  if (!Array.isArray(c.aset)) c.aset = [];
  c.amap.length = areas.length;
  c.aset.length = areas.length;
  const used = new Set<number>();
  for (let i = 0; i < areas.length; i++) {
    const k = c.amap[i];
    if (c.aset[i] && k >= 0 && k < designs.length) used.add(k);
    else c.amap[i] = -1;
  }
  for (let i = 0; i < areas.length; i++) {
    if (c.amap[i] >= 0) continue;
    const at = areaToneOf(areas[i]);
    let pick = -1;
    for (let k = 0; k < designs.length; k++) {
      if (used.has(k)) continue;
      if (fitsArea(at, designs[k])) {
        pick = k;
        break;
      }
    }
    if (pick < 0) {
      for (let k = 0; k < designs.length; k++) {
        if (!used.has(k)) {
          pick = k;
          break;
        }
      }
    }
    if (pick < 0) {
      for (let k = 0; k < designs.length; k++) {
        if (fitsArea(at, designs[k])) {
          pick = k;
          break;
        }
      }
    }
    if (pick < 0 && designs.length) pick = 0;
    if (pick >= 0) used.add(pick);
    c.amap[i] = pick;
  }
  return c.amap;
}
