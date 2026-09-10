/**
 * DOM-free Photoshop (.psd) reader — the bespoke parser from
 * `mockup-atolyesi.html`, ported so it runs on the server too (Phase 1 of the
 * migration, memory `mockup-screen-migration`).
 *
 * Kept deliberately close to the original `psdParse` / `psdChannel` /
 * `psdOverlays` / `psdDescriptorFind`. The only changes are DOM removal:
 *   - `new ImageData(w, h)`           → a plain {@link Raster} buffer
 *   - the `<canvas>` in `psdOverlays` → the overlay's raw RGBA buffer
 * Error messages are Turkish, verbatim, because the UI surfaces them as-is.
 *
 * Not swapped for `ag-psd`: this code needs the smart-object transform quad
 * (`Trnf` / `VlLs` descriptor), which `ag-psd` does not expose.
 */

import { PSD_BLEND } from "./blend";
import type { BlendMode, Overlay, Quad, Raster } from "./types";

export class PsdParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PsdParseError";
  }
}

export interface PsdParseResult {
  /** The PSD's own composite image ("Maximize Compatibility"), full resolution. */
  composite: Raster;
  width: number;
  height: number;
  /** First print area in reading order, or `null` when no smart object was read. */
  quad: Quad | null;
  /** Every readable smart-object transform, top-to-bottom then left-to-right. */
  quads: Quad[];
  /** Layer name per entry of {@link quads} (`"?"` when the layer is unnamed). */
  areaNames: string[];
  /** Visible layers above the lowest print area, to redraw over the design. */
  overlays: Overlay[];
  /** Name of the first-read print-area layer, when any. */
  layerName: string | null;
  /** How many smart objects had a readable transform. */
  smartCount: number;
}

interface LayerRec {
  top: number;
  left: number;
  bottom: number;
  right: number;
  chIds: number[];
  chLens: number[];
  blend: string;
  opacity: number;
  clip: number;
  hidden: boolean;
  mask: { top: number; left: number; bottom: number; right: number } | null;
  smart: boolean;
  name: string | null;
}

interface SmartFind {
  name: string | null;
  t: number[];
  rec: LayerRec;
}

/** Parse a `.psd` buffer. Verbatim port of the tool's `psdParse(buf)`. */
export function parsePsd(buf: ArrayBuffer): PsdParseResult {
  const dv = new DataView(buf);
  const U8 = new Uint8Array(buf);
  let o = 0;
  const u8 = () => U8[o++];
  const u16 = () => {
    const v = dv.getUint16(o);
    o += 2;
    return v;
  };
  const i16 = () => {
    const v = dv.getInt16(o);
    o += 2;
    return v;
  };
  const u32 = () => {
    const v = dv.getUint32(o);
    o += 4;
    return v;
  };
  const sig = () => String.fromCharCode(U8[o++], U8[o++], U8[o++], U8[o++]);

  if (sig() !== "8BPS") throw new PsdParseError("PSD dosyası değil");
  const ver = u16();
  if (ver !== 1) throw new PsdParseError("PSB desteklenmiyor — .psd olarak kaydet");
  o += 6;
  const channels = u16();
  const height = u32();
  const width = u32();
  const depth = u16();
  const mode = u16();
  if (depth !== 8) throw new PsdParseError(depth + " bit — 8 bit/kanal olarak kaydet");
  if (mode !== 3) throw new PsdParseError("RGB modunda kaydet");

  {
    const n = u32();
    o += n;
  } // color mode data
  {
    const n = u32();
    o += n;
  } // image resources
  const lmiLen = u32();
  const lmiEnd = o + lmiLen;

  // --- layer records: find every smart object's placed transform ---
  let quad: Quad | null = null;
  const found: SmartFind[] = [];
  const layers: LayerRec[] = [];
  let chanStart = -1;
  try {
    const layerInfoLen = u32();
    const layerInfoEnd = o + layerInfoLen;
    let count = i16();
    if (count < 0) count = -count;
    for (let L = 0; L < count && o < layerInfoEnd; L++) {
      const lt = dv.getInt32(o);
      const ll = dv.getInt32(o + 4);
      const lb = dv.getInt32(o + 8);
      const lr = dv.getInt32(o + 12);
      o += 16; // rect
      const nch = u16();
      const chLens: number[] = [];
      const chIds: number[] = [];
      for (let i = 0; i < nch; i++) {
        chIds.push(dv.getInt16(o));
        o += 2;
        chLens.push(u32());
      }
      o += 4; // blend signature
      const blendKey = sig();
      const lop = u8();
      const lclip = u8();
      const lflags = u8();
      o += 1; // filler
      const rec: LayerRec = {
        top: lt,
        left: ll,
        bottom: lb,
        right: lr,
        chIds,
        chLens,
        blend: blendKey,
        opacity: lop,
        clip: lclip,
        hidden: !!(lflags & 2),
        mask: null,
        smart: false,
        name: null,
      };
      layers.push(rec);
      const extraLen = u32();
      const extraEnd = o + extraLen;
      {
        const n = u32();
        if (n >= 16)
          rec.mask = {
            top: dv.getInt32(o),
            left: dv.getInt32(o + 4),
            bottom: dv.getInt32(o + 8),
            right: dv.getInt32(o + 12),
          };
        o += n;
      } // mask
      {
        const n = u32();
        o += n;
      } // blend ranges
      const nameLen = U8[o];
      o += 1 + nameLen;
      o += (4 - ((nameLen + 1) % 4)) % 4; // pascal pad
      let uniName: string | null = null;
      while (o + 12 <= extraEnd) {
        const s4 = sig();
        if (s4 !== "8BIM" && s4 !== "8B64") {
          o -= 4;
          break;
        }
        const key = sig();
        const len = u32();
        const blockEnd = o + len + (len % 2);
        if (key === "luni") {
          const n = u32();
          let str = "";
          for (let i = 0; i < n; i++) str += String.fromCharCode(dv.getUint16(o + i * 2));
          uniName = str;
        } else if (key === "SoLd" || key === "SoLE" || key === "PlLd") {
          const t = findTransform(dv, U8, o, blockEnd);
          if (t) {
            found.push({ name: uniName, t, rec });
            rec.smart = true;
          }
        }
        o = blockEnd;
      }
      rec.name = uniName;
      o = extraEnd;
      if (found.length && found[found.length - 1].name === null)
        found[found.length - 1].name = uniName;
    }
    chanStart = o; // channel pixel data starts here
  } catch {
    // layer section unreadable — the composite is still returned
  }

  o = lmiEnd;

  // --- composite image ("Maximize Compatibility" must be on) ---
  const comp = u16();
  const npx = width * height;
  const nc = Math.min(channels, 4);
  const planes: Uint8Array[] = [];
  if (comp === 0) {
    for (let c = 0; c < nc; c++) {
      planes.push(U8.subarray(o, o + npx));
      o += npx;
    }
  } else if (comp === 1) {
    const counts = new Uint16Array(height * channels);
    for (let i = 0; i < height * channels; i++) counts[i] = u16();
    for (let c = 0; c < channels; c++) {
      if (c >= nc) {
        for (let y = 0; y < height; y++) o += counts[c * height + y];
        continue;
      }
      const plane = new Uint8Array(npx);
      let w2 = 0;
      for (let y = 0; y < height; y++) {
        const end = o + counts[c * height + y];
        while (o < end) {
          const n = dv.getInt8(o++);
          if (n >= 0) {
            for (let i = 0; i <= n; i++) plane[w2++] = U8[o++];
          } else if (n > -128) {
            const b = U8[o++];
            for (let i = 0; i < 1 - n; i++) plane[w2++] = b;
          }
        }
        o = end;
      }
      planes.push(plane);
    }
  } else {
    throw new PsdParseError('ZIP sıkıştırmalı PSD — "Maximize Compatibility" açık kaydet');
  }

  if (planes.length < 3)
    throw new PsdParseError('Kompozit görüntü yok — "Maximize Compatibility" açık kaydet');

  const composite: Raster = {
    data: new Uint8ClampedArray(npx * 4),
    width,
    height,
  };
  const P = composite.data;
  const R = planes[0];
  const G = planes[1];
  const B = planes[2];
  const A = planes[3];
  for (let i = 0; i < npx; i++) {
    P[i * 4] = R[i];
    P[i * 4 + 1] = G[i];
    P[i * 4 + 2] = B[i];
    P[i * 4 + 3] = A ? A[i] : 255;
  }

  // Print areas: every smart object with a readable transform is one area.
  // No name filter — layer names ("Layer 1", "Layer 1 copy", …) are all taken;
  // a group mockup gives each garment its own area.
  const toQuad = (t: number[]): Quad => [
    [t[0] / width, t[1] / height],
    [t[2] / width, t[3] / height],
    [t[4] / width, t[5] / height],
    [t[6] / width, t[7] / height],
  ];
  // Reading order: top row to bottom, left to right within a row, so the UI's
  // 1, 2, 3 … match the garment order in the image.
  const pairs = found.map((pk) => ({ q: toQuad(pk.t), nm: pk.name || "?" }));
  const ccy = (p: { q: Quad }) => (p.q[0][1] + p.q[1][1] + p.q[2][1] + p.q[3][1]) / 4;
  const ccx = (p: { q: Quad }) => (p.q[0][0] + p.q[1][0] + p.q[2][0] + p.q[3][0]) / 4;
  const hAvg = pairs.length
    ? pairs.reduce((a, p) => a + Math.abs(p.q[3][1] - p.q[0][1]), 0) / pairs.length
    : 0;
  const rowTol = Math.max(0.02, hAvg * 0.5);
  pairs.sort((a, b) =>
    Math.abs(ccy(a) - ccy(b)) > rowTol ? ccy(a) - ccy(b) : ccx(a) - ccx(b),
  );
  const quads = pairs.map((p) => p.q);
  if (quads.length) quad = quads[0];

  // Overlays: everything above the LOWEST print area is redrawn over the design.
  let overlays: Overlay[] = [];
  if (found.length && chanStart > 0) {
    let si = -1;
    const skip = new Set<number>();
    for (const pk of found) {
      const k = layers.indexOf(pk.rec);
      if (k < 0) continue;
      skip.add(k);
      if (si < 0 || k < si) si = k;
    }
    if (si >= 0) {
      try {
        overlays = extractOverlays(dv, U8, layers, chanStart, si, skip);
      } catch {
        overlays = [];
      }
    }
  }

  return {
    composite,
    width,
    height,
    quad,
    quads,
    areaNames: pairs.map((p) => p.nm),
    overlays,
    layerName: found.length ? found[0].name : null,
    smartCount: found.length,
  };
}

/** Decode one layer channel (0 = raw, 1 = RLE). Port of `psdChannel`. */
function decodeChannel(
  dv: DataView,
  U8: Uint8Array,
  off: number,
  len: number,
  w: number,
  h: number,
): Uint8Array | null {
  if (w <= 0 || h <= 0) return null;
  const comp = dv.getUint16(off);
  let o = off + 2;
  const out = new Uint8Array(w * h);
  if (comp === 0) {
    out.set(U8.subarray(o, o + Math.min(w * h, len - 2)));
    return out;
  }
  if (comp !== 1) return null; // ZIP not supported
  const counts = new Uint16Array(h);
  for (let y = 0; y < h; y++) {
    counts[y] = dv.getUint16(o);
    o += 2;
  }
  let wpos = 0;
  for (let y = 0; y < h; y++) {
    const end = o + counts[y];
    while (o < end && wpos < out.length) {
      const n = dv.getInt8(o++);
      if (n >= 0) {
        for (let i = 0; i <= n && wpos < out.length; i++) out[wpos++] = U8[o++];
      } else if (n > -128) {
        const b = U8[o++];
        for (let i = 0; i < 1 - n && wpos < out.length; i++) out[wpos++] = b;
      }
    }
    o = end;
  }
  return out;
}

/**
 * Decode the visible layers ABOVE the lowest print area. Port of `psdOverlays`;
 * the per-layer `<canvas>` is replaced by the overlay's own RGBA buffer.
 */
function extractOverlays(
  dv: DataView,
  U8: Uint8Array,
  layers: LayerRec[],
  chanStart: number,
  smartIdx: number,
  skip: Set<number>,
): Overlay[] {
  const out: Overlay[] = [];
  let o = chanStart;
  for (let i = 0; i < layers.length; i++) {
    const L = layers[i];
    const w = L.right - L.left;
    const h = L.bottom - L.top;
    // the print-area layers themselves are not overlays (in a group mockup the
    // second smart object was covering the first)
    const need =
      i > smartIdx && !skip.has(i) && !L.hidden && w > 0 && h > 0 && L.opacity > 0;
    const chan: Record<number, Uint8Array | null> = {};
    for (let c = 0; c < L.chIds.length; c++) {
      const id = L.chIds[c];
      const len = L.chLens[c];
      if (need && (id === 0 || id === 1 || id === 2 || id === -1 || id === -2)) {
        const mw = id === -2 && L.mask ? L.mask.right - L.mask.left : w;
        const mh = id === -2 && L.mask ? L.mask.bottom - L.mask.top : h;
        chan[id] = decodeChannel(dv, U8, o, len, mw, mh);
      }
      o += len;
    }
    if (!need) continue;
    const c0 = chan[0];
    const c1 = chan[1];
    const c2 = chan[2];
    if (!c0 || !c1 || !c2) continue;
    const data = new Uint8ClampedArray(w * h * 4);
    const Ac = chan[-1];
    const MK = chan[-2];
    for (let p = 0; p < w * h; p++) {
      let a = Ac ? Ac[p] : 255;
      if (MK && L.mask) {
        const px = (p % w) + L.left;
        const py = ((p / w) | 0) + L.top;
        const mx = px - L.mask.left;
        const my = py - L.mask.top;
        const mw = L.mask.right - L.mask.left;
        const mh = L.mask.bottom - L.mask.top;
        a = mx >= 0 && my >= 0 && mx < mw && my < mh ? (a * MK[my * mw + mx]) / 255 : 0;
      }
      data[p * 4] = c0[p];
      data[p * 4 + 1] = c1[p];
      data[p * 4 + 2] = c2[p];
      data[p * 4 + 3] = a;
    }
    out.push({
      data,
      x: L.left,
      y: L.top,
      w,
      h,
      blend: (PSD_BLEND[L.blend] ?? "source-over") as BlendMode,
      alpha: L.opacity / 255,
      clip: !!L.clip,
      name: L.name ?? "",
    });
  }
  return out;
}

/**
 * Scan a smart-object block for the `Trnf` / `VlLs` descriptor and return its
 * 8 doubles (the placed layer's corner quad, in document pixels), or `null`.
 * Port of `psdDescriptorFind`.
 */
export function findTransform(
  dv: DataView,
  U8: Uint8Array,
  start: number,
  end: number,
): number[] | null {
  for (let i = start; i + 12 < end; i++) {
    if (U8[i] === 0x54 && U8[i + 1] === 0x72 && U8[i + 2] === 0x6e && U8[i + 3] === 0x66) {
      // 'Trnf'
      let p = i + 4;
      if (String.fromCharCode(U8[p], U8[p + 1], U8[p + 2], U8[p + 3]) !== "VlLs") continue;
      p += 4;
      const n = dv.getUint32(p);
      p += 4;
      if (n !== 8) continue;
      const out: number[] = [];
      for (let k = 0; k < 8; k++) {
        const ty = String.fromCharCode(U8[p], U8[p + 1], U8[p + 2], U8[p + 3]);
        p += 4;
        if (ty !== "doub") {
          out.length = 0;
          break;
        }
        out.push(dv.getFloat64(p));
        p += 8;
      }
      if (out.length === 8) return out;
    }
  }
  return null;
}
