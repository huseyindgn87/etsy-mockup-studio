/**
 * The compositing core, ported line-for-line from `mockup-atolyesi.html`:
 * `stampQuad` (warp + fabric shading + wrinkle displacement + Blend-If) and the
 * `compose` orchestrator (lay mockup, stamp each print area, redraw overlays).
 *
 * Operates only on {@link Raster} buffers. `Calibration` slider units are
 * unchanged from the tool.
 *
 * PARITY (Phase 2): the wrinkle-displacement blur radius and gradient step are
 * anchored to the print quad's own pixel span, not `max(W, H)`. The tool used
 * `dispR * max(W,H) / 1400` with a fixed 2px gradient step, which made the
 * displacement field depend on the render size — a fit-scale client preview and
 * a full-res server render diverged. Both are now a fixed fraction of the quad,
 * so the field (expressed in design UV) is the same at any resolution.
 */

import { drawOverlays } from "./blend";
import {
  containFit,
  homography,
  quadList,
  quadMetrics,
  quadToPx,
} from "./geometry";
import { blitScaled } from "./raster";
import type { Calibration, Overlay, Quad, Raster } from "./types";

/**
 * Stamp one design into one print area, mutating `M` (the working RGBA buffer)
 * in place. Returns whether any pixel was written.
 */
export function stampQuad(
  M: Uint8ClampedArray,
  D: Uint8ClampedArray,
  dw: number,
  dh: number,
  c: Calibration,
  W: number,
  H: number,
  area: Quad,
): boolean {
  const q = quadToPx(area, W, H);
  const Hi = homography(q);

  const xs = q.map((p) => p[0]);
  const ys = q.map((p) => p[1]);
  const x0 = Math.max(0, Math.floor(Math.min(...xs)));
  const x1 = Math.min(W, Math.ceil(Math.max(...xs)));
  const y0 = Math.max(0, Math.floor(Math.min(...ys)));
  const y1 = Math.min(H, Math.ceil(Math.max(...ys)));
  if (x1 <= x0 || y1 <= y0) return false;

  // contain-fit design, corrected for the quad's own aspect ratio
  const z = c.zoom / 100;
  const { w: quadW, h: quadH, ar: quadAr } = quadMetrics(q);
  const { uw, uh, uOff, vOff } = containFit(dw, dh, quadAr, z);

  // wrinkle-map scale, as a fraction of the quad's pixel span (see PARITY note).
  // At the tool's reference (quad ≈ half of a 1400px canvas) these reduce to the
  // old `rad = dispR` and `step = 2`.
  const quadSpan = Math.max(quadW, quadH);
  const dstep = Math.max(2, Math.round(quadSpan / 350));

  // mean luminance inside quad
  let sum = 0;
  let n = 0;
  for (let y = y0; y < y1; y += 2) {
    for (let x = x0; x < x1; x += 2) {
      const w = Hi[6] * x + Hi[7] * y + Hi[8];
      const u = (Hi[0] * x + Hi[1] * y + Hi[2]) / w;
      const v = (Hi[3] * x + Hi[4] * y + Hi[5]) / w;
      if (u < 0 || u > 1 || v < 0 || v > 1) continue;
      const i = (y * W + x) * 4;
      sum += 0.299 * M[i] + 0.587 * M[i + 1] + 0.114 * M[i + 2];
      n++;
    }
  }
  if (!n) return false;
  const mean = Math.max(8, sum / n);
  const shade = c.shade / 100;
  const disp = c.disp || 0;
  const b1 = c.b1 | 0;
  const b2 = c.b2 === undefined ? 0 : c.b2 | 0;
  const w1 = c.w1 === undefined ? 255 : c.w1 | 0;
  const w2 = c.w2 === undefined ? 255 : c.w2 | 0;
  const bfOn = b1 > 0 || b2 > 0 || w1 < 255 || w2 < 255;
  const lum = (x: number, y: number) => {
    const i = (y * W + x) * 4;
    return 0.299 * M[i] + 0.587 * M[i + 1] + 0.114 * M[i + 2];
  };

  // wrinkle map: blurred luminance (reads fold shape, not weave)
  let BL: Float32Array | null = null;
  let bx0 = 0;
  let by0 = 0;
  let bw = 0;
  let bh = 0;
  if (disp > 0) {
    const rad = Math.max(1, Math.round(((c.dispR || 12) * quadSpan) / 700));
    const pad = rad * 2 + dstep + 2;
    bx0 = Math.max(0, x0 - pad);
    by0 = Math.max(0, y0 - pad);
    const bx1 = Math.min(W, x1 + pad);
    const by1 = Math.min(H, y1 + pad);
    bw = bx1 - bx0;
    bh = by1 - by0;
    const src = new Float32Array(bw * bh);
    for (let y = 0; y < bh; y++) {
      for (let xx = 0; xx < bw; xx++) src[y * bw + xx] = lum(bx0 + xx, by0 + y);
    }
    const tmp = new Float32Array(bw * bh);
    BL = new Float32Array(bw * bh);
    const blurH = (inp: Float32Array, out: Float32Array) => {
      for (let y = 0; y < bh; y++) {
        let acc = 0;
        const row = y * bw;
        for (let xx = -rad; xx <= rad; xx++) {
          acc += inp[row + Math.min(bw - 1, Math.max(0, xx))];
        }
        const inv = 1 / (2 * rad + 1);
        for (let xx = 0; xx < bw; xx++) {
          out[row + xx] = acc * inv;
          acc +=
            inp[row + Math.min(bw - 1, xx + rad + 1)] -
            inp[row + Math.min(bw - 1, Math.max(0, xx - rad))];
        }
      }
    };
    const blurV = (inp: Float32Array, out: Float32Array) => {
      for (let xx = 0; xx < bw; xx++) {
        let acc = 0;
        for (let y = -rad; y <= rad; y++) {
          acc += inp[Math.min(bh - 1, Math.max(0, y)) * bw + xx];
        }
        const inv = 1 / (2 * rad + 1);
        for (let y = 0; y < bh; y++) {
          out[y * bw + xx] = acc * inv;
          acc +=
            inp[Math.min(bh - 1, y + rad + 1) * bw + xx] -
            inp[Math.min(bh - 1, Math.max(0, y - rad)) * bw + xx];
        }
      }
    };
    blurH(src, tmp);
    blurV(tmp, BL);
    blurH(BL, tmp);
    blurV(tmp, BL);
  }
  const bl2 = (x: number, y: number) => {
    const xx = Math.min(bw - 1, Math.max(0, x - bx0));
    const yy = Math.min(bh - 1, Math.max(0, y - by0));
    return BL![yy * bw + xx];
  };

  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const w = Hi[6] * x + Hi[7] * y + Hi[8];
      let u = (Hi[0] * x + Hi[1] * y + Hi[2]) / w;
      let v = (Hi[3] * x + Hi[4] * y + Hi[5]) / w;
      if (u < -0.02 || u > 1.02 || v < -0.02 || v > 1.02) continue;

      if (BL) {
        const gx = (bl2(x + dstep, y) - bl2(x - dstep, y)) / 255;
        const gy = (bl2(x, y + dstep) - bl2(x, y - dstep)) / 255;
        u += gx * disp * 0.01;
        v += gy * disp * 0.01;
      }

      const du = (u - uOff) / uw;
      const dv = (v - vOff) / uh;
      if (du < 0 || du >= 1 || dv < 0 || dv >= 1) continue;

      const sx = du * (dw - 1);
      const sy = dv * (dh - 1);
      const ix = sx | 0;
      const iy = sy | 0;
      const fx = sx - ix;
      const fy = sy - iy;
      const ix2 = Math.min(ix + 1, dw - 1);
      const iy2 = Math.min(iy + 1, dh - 1);
      const p00 = (iy * dw + ix) * 4;
      const p10 = (iy * dw + ix2) * 4;
      const p01 = (iy2 * dw + ix) * 4;
      const p11 = (iy2 * dw + ix2) * 4;
      const bl = (o: number) => {
        const a = D[p00 + o];
        const b = D[p10 + o];
        const cc = D[p01 + o];
        const d = D[p11 + o];
        return (a * (1 - fx) + b * fx) * (1 - fy) + (cc * (1 - fx) + d * fx) * fy;
      };
      let A = bl(3) / 255;
      if (A <= 0.004) continue;

      // Blend-If, underlying layer: let the fabric's dark/light ends punch through
      if (bfOn) {
        const L = lum(x, y);
        let f = 1;
        if (L <= b1) f = 0;
        else if (L < b2) f = (L - b1) / (b2 - b1);
        if (L >= w2) f = 0;
        else if (L > w1) f = Math.min(f, (w2 - L) / (w2 - w1));
        A *= f;
        if (A <= 0.004) continue;
      }

      let s = 1 + (lum(x, y) / mean - 1) * shade;
      if (s < 0) s = 0;
      if (s > 2.2) s = 2.2;

      const i = (y * W + x) * 4;
      const r = bl(0) * s;
      const g = bl(1) * s;
      const b = bl(2) * s;
      M[i] = r * A + M[i] * (1 - A);
      M[i + 1] = g * A + M[i + 1] * (1 - A);
      M[i + 2] = b * A + M[i + 2] * (1 - A);
    }
  }
  return true;
}

export interface ComposeInput {
  /** Mockup composite at its native (PSD) resolution. */
  mock: Raster;
  /** The design to place in every area, unless `perArea` overrides it. */
  design?: Raster | null;
  /** Per-area design override for group mockups; `perArea[i]` beats `design`. */
  perArea?: (Raster | null)[] | null;
  calibration: Calibration;
  overlays?: Overlay[];
}

/**
 * Full render into a fresh {@link Raster} of size W×H. Equivalent to the tool's
 * `compose(octx, mock, design, c, W, H, item, perArea)`.
 */
export function compose(input: ComposeInput, W: number, H: number): Raster {
  const { mock, design, perArea, calibration: c, overlays } = input;
  const dest: Raster = { data: new Uint8ClampedArray(W * H * 4), width: W, height: H };
  blitScaled(dest, mock, 0, 0, W, H);

  const areas = quadList(c);
  const hasAny = !!design || (!!perArea && perArea.some(Boolean));
  if (hasAny && areas.length) {
    for (let i = 0; i < areas.length; i++) {
      const img = (perArea && perArea[i]) || design;
      if (!img) continue;
      stampQuad(dest.data, img.data, img.width, img.height, c, W, H, areas[i]);
    }
  }

  drawOverlays(dest, overlays, W, H, mock.width, mock.height);
  return dest;
}
