/**
 * JPEG-quality binary search — find the quality that lands an encode inside a
 * target byte-size window. Ported from the tool's `encode()` bisection.
 *
 * Pure: the caller supplies `encode(quality 0..1) → Promise<byteLength>` (sharp
 * on the server). Falls back to the closest trial when nothing lands in range.
 */

export interface QualitySearchOptions {
  /** Inclusive target window, in bytes. */
  min: number;
  max: number;
  /** Quality bracket, 0..1 (defaults 0.60 / 0.98, as the tool used). */
  lowQ?: number;
  highQ?: number;
  /** Bisection steps (default 8). */
  steps?: number;
}

export interface QualitySearchResult {
  quality: number;
  size: number;
  /** Whether `size` fell within `[min, max]`. */
  inRange: boolean;
}

export async function searchJpegQuality(
  encode: (quality: number) => Promise<number>,
  opts: QualitySearchOptions,
): Promise<QualitySearchResult> {
  const { min, max } = opts;
  let a = opts.lowQ ?? 0.6;
  let b = opts.highQ ?? 0.98;
  const steps = Math.max(1, opts.steps ?? 8);

  let best: QualitySearchResult | null = null;
  for (let i = 0; i < steps; i++) {
    const quality = (a + b) / 2;
    const size = await encode(quality);
    // keep the best fallback: the largest size still ≤ max; or, if every trial
    // overshoots, the smallest size. (Same rule as the original.)
    if (
      !best ||
      (size <= max && size > best.size) ||
      (best.size > max && size < best.size)
    ) {
      best = { quality, size, inRange: size >= min && size <= max };
    }
    if (size >= min && size <= max) return { quality, size, inRange: true };
    if (size < min) a = quality;
    else b = quality;
  }
  return best as QualitySearchResult;
}
