/**
 * Wire types shared by the batch route, the render pool, and the worker.
 * Image payloads travel as `ArrayBuffer` so they can be transferred (zero-copy)
 * across the worker boundary.
 */

import type { BlendMode, Calibration } from "./types";

export interface RenderOverlayInput {
  bytes: ArrayBuffer;
  x: number;
  y: number;
  blend: BlendMode;
  alpha: number;
  clip: boolean;
  name: string;
}

export interface RenderJobInput {
  /** Encoded (PNG/JPEG) mockup composite. */
  mock: ArrayBuffer;
  /** Encoded design applied to every print area, if any. */
  design: ArrayBuffer | null;
  /** Per-area design overrides; `null` entries fall back to {@link design}. */
  areaDesigns: (ArrayBuffer | null)[] | null;
  overlays: RenderOverlayInput[];
  calibration: Calibration;
  /** Output size; when omitted the worker uses the decoded mockup's size. */
  width?: number;
  height?: number;
  format: "jpeg" | "png";
  /** JPEG target window in bytes (ignored for PNG). */
  targetMin: number;
  targetMax: number;
}

export type RenderJobResult =
  | { ok: true; bytes: ArrayBuffer; ext: "jpg" | "png"; size: number }
  | { ok: false; error: string };
