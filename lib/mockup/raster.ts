/**
 * Plain RGBA buffer helpers. No canvas, no native deps — these stand in for the
 * `document.createElement('canvas')` / `getImageData` / `drawImage` calls the
 * original tool used only for pixel plumbing.
 */

import type { Raster } from "./types";

export function createRaster(width: number, height: number): Raster {
  return { data: new Uint8ClampedArray(width * height * 4), width, height };
}

export function cloneRaster(r: Raster): Raster {
  return { data: new Uint8ClampedArray(r.data), width: r.width, height: r.height };
}

/** Bilinear sample of `src` at fractional pixel (fx, fy), clamped at edges. */
export function sampleBilinear(
  src: Raster,
  fx: number,
  fy: number,
  out: [number, number, number, number],
): void {
  const { data, width: w, height: h } = src;
  const x = Math.min(w - 1, Math.max(0, fx));
  const y = Math.min(h - 1, Math.max(0, fy));
  const ix = x | 0;
  const iy = y | 0;
  const tx = x - ix;
  const ty = y - iy;
  const ix2 = Math.min(ix + 1, w - 1);
  const iy2 = Math.min(iy + 1, h - 1);
  const p00 = (iy * w + ix) * 4;
  const p10 = (iy * w + ix2) * 4;
  const p01 = (iy2 * w + ix) * 4;
  const p11 = (iy2 * w + ix2) * 4;
  for (let k = 0; k < 4; k++) {
    const a = data[p00 + k];
    const b = data[p10 + k];
    const c = data[p01 + k];
    const d = data[p11 + k];
    out[k] = (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
  }
}

/**
 * Draw `src` into `dest` scaled to fill the rectangle (dx, dy, dw, dh),
 * replacing dest pixels (opaque copy, like `drawImage` onto a fresh canvas).
 * Used to lay the mockup composite down before stamping.
 */
export function blitScaled(
  dest: Raster,
  src: Raster,
  dx: number,
  dy: number,
  dw: number,
  dh: number,
): void {
  const tmp: [number, number, number, number] = [0, 0, 0, 0];
  const x0 = Math.max(0, Math.floor(dx));
  const y0 = Math.max(0, Math.floor(dy));
  const x1 = Math.min(dest.width, Math.ceil(dx + dw));
  const y1 = Math.min(dest.height, Math.ceil(dy + dh));
  const sxScale = src.width / dw;
  const syScale = src.height / dh;
  for (let y = y0; y < y1; y++) {
    const sy = (y + 0.5 - dy) * syScale - 0.5;
    for (let x = x0; x < x1; x++) {
      const sx = (x + 0.5 - dx) * sxScale - 0.5;
      sampleBilinear(src, sx, sy, tmp);
      const i = (y * dest.width + x) * 4;
      dest.data[i] = tmp[0];
      dest.data[i + 1] = tmp[1];
      dest.data[i + 2] = tmp[2];
      dest.data[i + 3] = tmp[3];
    }
  }
}

/** Box-averaged RGB over a sub-rectangle of `src`, skipping near-transparent pixels. */
export function averageRGB(
  src: Raster,
  rx: number,
  ry: number,
  rw: number,
  rh: number,
): { r: number; g: number; b: number; n: number } {
  const { data, width: w, height: h } = src;
  const x0 = Math.max(0, Math.floor(rx));
  const y0 = Math.max(0, Math.floor(ry));
  const x1 = Math.min(w, Math.ceil(rx + rw));
  const y1 = Math.min(h, Math.ceil(ry + rh));
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * w + x) * 4;
      if (data[i + 3] < 40) continue;
      r += data[i];
      g += data[i + 1];
      b += data[i + 2];
      n++;
    }
  }
  return n ? { r: r / n, g: g / n, b: b / n, n } : { r: 0, g: 0, b: 0, n: 0 };
}

/**
 * Downscale `src` to `S`×`S` by averaging each source cell (a cheap stand-in for
 * `drawImage(img, 0, 0, S, S)`). Returns the small RGBA buffer.
 */
export function downscaleSquare(src: Raster, S: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(S * S * 4);
  const cw = src.width / S;
  const ch = src.height / S;
  for (let ty = 0; ty < S; ty++) {
    for (let tx = 0; tx < S; tx++) {
      const sx0 = Math.floor(tx * cw);
      const sy0 = Math.floor(ty * ch);
      const sx1 = Math.max(sx0 + 1, Math.floor((tx + 1) * cw));
      const sy1 = Math.max(sy0 + 1, Math.floor((ty + 1) * ch));
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let n = 0;
      for (let y = sy0; y < sy1 && y < src.height; y++) {
        for (let x = sx0; x < sx1 && x < src.width; x++) {
          const i = (y * src.width + x) * 4;
          r += src.data[i];
          g += src.data[i + 1];
          b += src.data[i + 2];
          a += src.data[i + 3];
          n++;
        }
      }
      const o = (ty * S + tx) * 4;
      if (n) {
        out[o] = r / n;
        out[o + 1] = g / n;
        out[o + 2] = b / n;
        out[o + 3] = a / n;
      }
    }
  }
  return out;
}
