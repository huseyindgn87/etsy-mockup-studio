/**
 * Coercion helpers for untrusted route input → the shapes `compose` expects.
 * Isomorphic (no `sharp`, no DOM). Malformed fields fall back to the tool's
 * defaults so the compositor never sees garbage.
 */

import { DEFAULT_QUAD, type BlendMode, type Calibration, type Quad } from "./types";

export const num = (v: unknown, fallback: number): number =>
  typeof v === "number" && Number.isFinite(v) ? v : fallback;

export const clamp = (v: number, lo: number, hi: number): number =>
  Math.min(hi, Math.max(lo, v));

const cloneQuad = (q: Quad): Quad => q.map((p) => [...p]) as Quad;

/** A quad is 4 points of 2 finite numbers each; anything else → `null`. */
export function toQuad(v: unknown): Quad | null {
  if (!Array.isArray(v) || v.length !== 4) return null;
  const out: number[][] = [];
  for (const p of v) {
    if (!Array.isArray(p) || p.length !== 2) return null;
    const x = Number(p[0]);
    const y = Number(p[1]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    out.push([x, y]);
  }
  return out as Quad;
}

const BLEND_MODES = new Set<string>([
  "source-over",
  "multiply",
  "screen",
  "overlay",
  "darken",
  "lighten",
  "color-dodge",
  "color-burn",
  "hard-light",
  "soft-light",
  "difference",
  "exclusion",
  "lighter",
  "hue",
  "saturation",
  "color",
  "luminosity",
]);

export function normalizeBlendMode(v: unknown): BlendMode {
  return typeof v === "string" && BLEND_MODES.has(v) ? (v as BlendMode) : "source-over";
}

/** Coerce untrusted JSON into a valid {@link Calibration}. */
export function coerceCalibration(raw: unknown): Calibration {
  const r = (raw ?? {}) as Record<string, unknown>;

  const qs = Array.isArray(r.qs)
    ? r.qs.map(toQuad).filter((q): q is Quad => q !== null)
    : [];
  const single = toQuad(r.q);
  const areas = qs.length ? qs : single ? [single] : [cloneQuad(DEFAULT_QUAD)];

  const aiRaw = Math.trunc(num(r.ai, 0));
  const ai = aiRaw >= 0 && aiRaw < areas.length ? aiRaw : 0;

  return {
    qs: areas,
    q: areas[0],
    ai,
    shade: clamp(num(r.shade, 15), 0, 130),
    disp: clamp(num(r.disp, 10), 0, 40),
    dispR: clamp(num(r.dispR, 12), 2, 48),
    zoom: clamp(num(r.zoom, 100), 40, 120),
    rot: clamp(num(r.rot, 0), -180, 180),
    b1: clamp(Math.trunc(num(r.b1, 0)), 0, 255),
    b2: clamp(Math.trunc(num(r.b2, 0)), 0, 255),
    w1: clamp(Math.trunc(num(r.w1, 255)), 0, 255),
    w2: clamp(Math.trunc(num(r.w2, 255)), 0, 255),
  };
}
