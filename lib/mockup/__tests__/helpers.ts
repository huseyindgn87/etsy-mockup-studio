import type { Raster } from "../types";

/** Solid-colour RGBA raster for tests. */
export function solid(
  w: number,
  h: number,
  r: number,
  g: number,
  b: number,
  a = 255,
): Raster {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    data[i * 4] = r;
    data[i * 4 + 1] = g;
    data[i * 4 + 2] = b;
    data[i * 4 + 3] = a;
  }
  return { data, width: w, height: h };
}

export function px(r: Raster, x: number, y: number): [number, number, number, number] {
  const i = (y * r.width + x) * 4;
  return [r.data[i], r.data[i + 1], r.data[i + 2], r.data[i + 3]];
}
