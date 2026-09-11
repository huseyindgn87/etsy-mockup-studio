/**
 * Quad geometry, ported verbatim from `mockup-atolyesi.html`.
 *
 * The compositor maps the unit square (design UV space) onto a print-area
 * {@link Quad} with a projective transform (homography). `homography` returns
 * the *inverse* matrix so the stamping loop can go dest-pixel → (u, v).
 */

import { type Calibration, DEFAULT_QUAD, type Pt, type Quad } from "./types";

/** Active print areas for a calibration. Legacy `q` is promoted into a list. */
export function quadList(c: Pick<Calibration, "qs" | "q" | "ai">): Quad[] {
  const qs =
    Array.isArray(c.qs) && c.qs.length
      ? c.qs
      : [c.q ?? (DEFAULT_QUAD.map((p) => [...p]) as Quad)];
  return qs;
}

/** Index of the active area, clamped into range. */
export function activeAreaIndex(c: Pick<Calibration, "qs" | "q" | "ai">): number {
  const n = quadList(c).length;
  const ai = c.ai ?? 0;
  return ai >= 0 && ai < n ? ai : 0;
}

/** Scale each normalised corner by (W, H) into pixel space. */
export function quadToPx(q: Quad, W: number, H: number): Quad {
  return q.map((p) => [p[0] * W, p[1] * H]) as Quad;
}

export function quadCentroid(q: Quad): Pt {
  return [
    (q[0][0] + q[1][0] + q[2][0] + q[3][0]) / 4,
    (q[0][1] + q[1][1] + q[2][1] + q[3][1]) / 4,
  ];
}

/**
 * Mean edge lengths of a pixel-space quad and their ratio.
 * `ar` is width / height; used to correct the design's contain-fit.
 */
export function quadMetrics(qPx: Quad): { w: number; h: number; ar: number } {
  const dist = (a: Pt, b: Pt) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const w = (dist(qPx[0], qPx[1]) + dist(qPx[3], qPx[2])) / 2;
  const h = (dist(qPx[0], qPx[3]) + dist(qPx[1], qPx[2])) / 2;
  return { w, h, ar: h > 1e-6 ? w / h : 1 };
}

/** Even-odd point-in-polygon for a 4-point pixel-space quad. */
export function pointInQuad(pt: Pt, qPx: Quad): boolean {
  let inside = false;
  for (let i = 0, j = 3; i < 4; j = i++) {
    const xi = qPx[i][0];
    const yi = qPx[i][1];
    const xj = qPx[j][0];
    const yj = qPx[j][1];
    if (
      yi > pt[1] !== yj > pt[1] &&
      pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi
    ) {
      inside = !inside;
    }
  }
  return inside;
}

/**
 * Rotate a normalised quad about its centroid by `deg`, in the pixel space
 * defined by (W, H). Returns a new normalised quad.
 */
export function rotateQuad(q: Quad, deg: number, W: number, H: number): Quad {
  const px = q.map((v) => [v[0] * W, v[1] * H]) as Quad;
  const cx = (px[0][0] + px[1][0] + px[2][0] + px[3][0]) / 4;
  const cy = (px[0][1] + px[1][1] + px[2][1] + px[3][1]) / 4;
  const a = (deg * Math.PI) / 180;
  const co = Math.cos(a);
  const si = Math.sin(a);
  return px.map((p) => {
    const dx = p[0] - cx;
    const dy = p[1] - cy;
    return [(cx + dx * co - dy * si) / W, (cy + dx * si + dy * co) / H];
  }) as Quad;
}

/*
 * Corner-editing helpers for the browser calibration UI (`MockupCanvas`). Quad
 * points may go slightly outside [0, 1] (bleed / seam prints extending past
 * the visible canvas); {@link clampCorner} bounds them to a generous but
 * finite range instead of leaving them unconstrained.
 */

/** Bound a single corner coordinate to a sane, finite range. */
export function clampCorner(v: number): number {
  return Math.min(1.5, Math.max(-0.5, v));
}

const cloneQuad = (q: Quad): Quad => q.map((p) => [...p]) as Quad;
const dist = (a: Pt, b: Pt): number => Math.hypot(a[0] - b[0], a[1] - b[1]);

/** Free corner drag: only the dragged corner moves (full keystone/perspective). */
export function moveCornerFree(startQuad: Quad, corner: number, pointer: Pt): Quad {
  const q = cloneQuad(startQuad);
  q[corner] = [clampCorner(pointer[0]), clampCorner(pointer[1])];
  return q;
}

/**
 * Ratio-preserving corner drag: scale the whole quad uniformly about the
 * diagonally opposite corner, so the shape (and its aspect ratio) never
 * distorts — only its size changes.
 */
export function scaleQuadFromCorner(startQuad: Quad, corner: number, pointer: Pt): Quad {
  const anchor = startQuad[(corner + 2) % 4];
  const from = dist(anchor, startQuad[corner]);
  const to = dist(anchor, pointer);
  const scale = from > 1e-6 ? Math.min(8, Math.max(0.05, to / from)) : 1;
  return startQuad.map((p) => [
    clampCorner(anchor[0] + (p[0] - anchor[0]) * scale),
    clampCorner(anchor[1] + (p[1] - anchor[1]) * scale),
  ]) as Quad;
}

/** Move the whole print area: translate every corner by the same delta. */
export function translateQuad(startQuad: Quad, dx: number, dy: number): Quad {
  return startQuad.map((p) => [clampCorner(p[0] + dx), clampCorner(p[1] + dy)]) as Quad;
}

/**
 * Contain-fit a design of aspect `dw/dh` inside a quad of aspect `quadAr`,
 * scaled by `zoom` (1 = fill). Returns the design's footprint in the quad's
 * own [0..1] UV space and the centring offset.
 */
export function containFit(
  dw: number,
  dh: number,
  quadAr: number,
  zoom: number,
): { uw: number; uh: number; uOff: number; vOff: number } {
  const r = dw / dh / quadAr;
  let uw: number;
  let uh: number;
  if (r >= 1) {
    uw = zoom;
    uh = zoom / r;
  } else {
    uh = zoom;
    uw = zoom * r;
  }
  return { uw, uh, uOff: (1 - uw) / 2, vOff: (1 - uh) / 2 };
}

/**
 * Unit square → quad homography, returned inverted (dest px → u, v) as a
 * row-major 3×3. Verbatim from the original `homography()`.
 */
export function homography(qPx: Quad): number[] {
  const [p0, p1, p2, p3] = qPx;
  const x0 = p0[0];
  const y0 = p0[1];
  const x1 = p1[0];
  const y1 = p1[1];
  const x2 = p2[0];
  const y2 = p2[1];
  const x3 = p3[0];
  const y3 = p3[1];
  const dx1 = x1 - x2;
  const dx2 = x3 - x2;
  const dy1 = y1 - y2;
  const dy2 = y3 - y2;
  const sx = x0 - x1 + x2 - x3;
  const sy = y0 - y1 + y2 - y3;
  const den = dx1 * dy2 - dx2 * dy1;
  let g: number;
  let h: number;
  if (Math.abs(den) < 1e-10) {
    g = 0;
    h = 0;
  } else {
    g = (sx * dy2 - dx2 * sy) / den;
    h = (dx1 * sy - sx * dy1) / den;
  }
  const a = x1 - x0 + g * x1;
  const b = x3 - x0 + h * x3;
  const c = x0;
  const d = y1 - y0 + g * y1;
  const e = y3 - y0 + h * y3;
  const f = y0;
  // invert 3x3 [a b c; d e f; g h 1]
  const A = e - f * h;
  const B = c * h - b;
  const C = b * f - c * e;
  const D = f * g - d;
  const E = a - c * g;
  const F = c * d - a * f;
  const G = d * h - e * g;
  const Hh = b * g - a * h;
  const I = a * e - b * d;
  const det = a * A + b * D + c * G;
  return [A / det, B / det, C / det, D / det, E / det, F / det, G / det, Hh / det, I / det];
}
