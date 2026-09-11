import { describe, expect, test } from "vitest";
import { findTransform, parsePsd, PsdParseError } from "../psd";

/* ---------- byte helpers ---------- */

const u16 = (n: number): number[] => [(n >>> 8) & 255, n & 255];
const u32 = (n: number): number[] => [
  (n >>> 24) & 255,
  (n >>> 16) & 255,
  (n >>> 8) & 255,
  n & 255,
];
const ascii = (s: string): number[] => [...s].map((c) => c.charCodeAt(0));
const f64 = (n: number): number[] => {
  const dv = new DataView(new ArrayBuffer(8));
  dv.setFloat64(0, n);
  return [...new Uint8Array(dv.buffer)];
};
const bufOf = (bytes: number[]): ArrayBuffer => new Uint8Array(bytes).buffer;

/* ---------- fixture builders ---------- */

interface FakePsdOpts {
  width: number;
  height: number;
  rgb: [number, number, number];
  compression: 0 | 1 | 2;
  version?: number;
  depth?: number;
  mode?: number;
}

/** A minimal, layer-free 8-bit RGB PSD with a flat-colour composite. */
function buildFlatPsd(opts: FakePsdOpts): ArrayBuffer {
  const { width: w, height: h, rgb, compression } = opts;
  const b: number[] = [];
  b.push(...ascii("8BPS"));
  b.push(...u16(opts.version ?? 1));
  b.push(0, 0, 0, 0, 0, 0);
  b.push(...u16(3)); // channels
  b.push(...u32(h), ...u32(w));
  b.push(...u16(opts.depth ?? 8));
  b.push(...u16(opts.mode ?? 3));
  b.push(...u32(0)); // color mode data
  b.push(...u32(0)); // image resources
  // layer & mask info: layer info length 2, then layer count 0
  b.push(...u32(6), ...u32(2), ...u16(0));
  b.push(...u16(compression));
  if (compression === 0) {
    for (let c = 0; c < 3; c++) for (let i = 0; i < w * h; i++) b.push(rgb[c]);
  } else if (compression === 1) {
    const rowHeader = (1 - w) & 255; // PackBits: repeat next byte `w` times
    for (let c = 0; c < 3; c++) for (let y = 0; y < h; y++) b.push(...u16(2));
    for (let c = 0; c < 3; c++) for (let y = 0; y < h; y++) b.push(rowHeader, rgb[c]);
  }
  return bufOf(b);
}

/** A 100×80 PSD with one named smart object and no overlays. */
function buildSmartObjectPsd(): ArrayBuffer {
  const w = 100;
  const h = 80;
  const name = "TASARIM";
  const trnf = [20, 10, 80, 10, 80, 70, 20, 70]; // corner quad in px

  const luniData = [...u32(name.length), ...name.split("").flatMap((c) => u16(c.charCodeAt(0)))];
  const soldData = [
    ...ascii("Trnf"),
    ...ascii("VlLs"),
    ...u32(8),
    ...trnf.flatMap((n) => [...ascii("doub"), ...f64(n)]),
  ];

  const extra: number[] = [];
  extra.push(...u32(0)); // layer mask
  extra.push(...u32(0)); // blend ranges
  extra.push(name.length, ...ascii(name)); // pascal name (7 + 1 = 8, already /4)
  extra.push(...ascii("8BIM"), ...ascii("luni"), ...u32(luniData.length), ...luniData);
  extra.push(...ascii("8BIM"), ...ascii("SoLd"), ...u32(soldData.length), ...soldData);

  const layer: number[] = [];
  layer.push(...u32(10), ...u32(20), ...u32(70), ...u32(80)); // top, left, bottom, right
  layer.push(...u16(0)); // channel count
  layer.push(...ascii("8BIM"), ...ascii("norm"));
  layer.push(255, 0, 0, 0); // opacity, clip, flags, filler
  layer.push(...u32(extra.length), ...extra);

  const layerInfo = [...u16(1), ...layer];
  const lmi = [...u32(layerInfo.length), ...layerInfo];

  const b: number[] = [];
  b.push(...ascii("8BPS"), ...u16(1), 0, 0, 0, 0, 0, 0);
  b.push(...u16(3), ...u32(h), ...u32(w), ...u16(8), ...u16(3));
  b.push(...u32(0), ...u32(0)); // color mode data, image resources
  b.push(...u32(lmi.length), ...lmi);
  b.push(...u16(0)); // composite compression: raw
  for (let c = 0; c < 3; c++) for (let i = 0; i < w * h; i++) b.push(120);
  return bufOf(b);
}

/* ---------- composite decode ---------- */

describe("parsePsd composite", () => {
  test("decodes a raw (uncompressed) composite", () => {
    const r = parsePsd(buildFlatPsd({ width: 8, height: 4, rgb: [40, 50, 60], compression: 0 }));
    expect(r.width).toBe(8);
    expect(r.height).toBe(4);
    expect(r.composite.data.length).toBe(8 * 4 * 4);
    expect([...r.composite.data.slice(0, 4)]).toEqual([40, 50, 60, 255]);
    expect([...r.composite.data.slice(-4)]).toEqual([40, 50, 60, 255]);
  });

  test("decodes an RLE (PackBits) composite", () => {
    const r = parsePsd(buildFlatPsd({ width: 8, height: 4, rgb: [10, 20, 30], compression: 1 }));
    expect([...r.composite.data.slice(0, 4)]).toEqual([10, 20, 30, 255]);
    const mid = (2 * 8 + 4) * 4;
    expect([...r.composite.data.slice(mid, mid + 4)]).toEqual([10, 20, 30, 255]);
  });

  test("a layer-free PSD reports no areas or overlays", () => {
    const r = parsePsd(buildFlatPsd({ width: 4, height: 4, rgb: [1, 2, 3], compression: 0 }));
    expect(r.quad).toBeNull();
    expect(r.quads).toEqual([]);
    expect(r.areaNames).toEqual([]);
    expect(r.overlays).toEqual([]);
    expect(r.layerName).toBeNull();
    expect(r.smartCount).toBe(0);
  });
});

/* ---------- header validation ---------- */

describe("parsePsd rejects bad files", () => {
  test("non-PSD signature", () => {
    expect(() => parsePsd(bufOf(ascii("NOPE!!")))).toThrow(PsdParseError);
    expect(() => parsePsd(bufOf(ascii("NOPE!!")))).toThrow("Not a PSD file");
  });

  test("PSB (version 2)", () => {
    expect(() =>
      parsePsd(buildFlatPsd({ width: 2, height: 2, rgb: [0, 0, 0], compression: 0, version: 2 })),
    ).toThrow(/PSB/);
  });

  test("16 bit/channel", () => {
    expect(() =>
      parsePsd(buildFlatPsd({ width: 2, height: 2, rgb: [0, 0, 0], compression: 0, depth: 16 })),
    ).toThrow(/8 bit/);
  });

  test("non-RGB mode", () => {
    expect(() =>
      parsePsd(buildFlatPsd({ width: 2, height: 2, rgb: [0, 0, 0], compression: 0, mode: 4 })),
    ).toThrow(/RGB/);
  });

  test("ZIP-compressed composite", () => {
    expect(() =>
      parsePsd(buildFlatPsd({ width: 2, height: 2, rgb: [0, 0, 0], compression: 2 })),
    ).toThrow(/Maximize Compatibility/);
  });
});

/* ---------- smart-object print areas ---------- */

describe("parsePsd smart objects", () => {
  const r = parsePsd(buildSmartObjectPsd());

  test("finds the print area and normalises its quad", () => {
    expect(r.smartCount).toBe(1);
    expect(r.quads).toHaveLength(1);
    expect(r.quads[0]).toEqual([
      [0.2, 0.125],
      [0.8, 0.125],
      [0.8, 0.875],
      [0.2, 0.875],
    ]);
    expect(r.quad).toEqual(r.quads[0]);
  });

  test("carries the unicode layer name", () => {
    expect(r.areaNames).toEqual(["TASARIM"]);
    expect(r.layerName).toBe("TASARIM");
  });

  test("a single smart object produces no overlays", () => {
    expect(r.overlays).toEqual([]);
  });
});

/* ---------- Trnf / VlLs descriptor ---------- */

describe("findTransform", () => {
  const build = (nums: number[], opts: { count?: number; type?: string } = {}) => {
    const bytes = [
      0xaa,
      0xbb,
      0xcc, // arbitrary prefix
      ...ascii("Trnf"),
      ...ascii("VlLs"),
      ...u32(opts.count ?? nums.length),
      ...nums.flatMap((n) => [...ascii((opts.type ?? "doub").padEnd(4).slice(0, 4)), ...f64(n)]),
    ];
    const ab = bufOf(bytes);
    return { dv: new DataView(ab), u8: new Uint8Array(ab) };
  };

  test("extracts the 8 doubles", () => {
    const nums = [20, 10, 80, 10, 80, 70, 20, 70];
    const { dv, u8 } = build(nums);
    expect(findTransform(dv, u8, 0, u8.length)).toEqual(nums);
  });

  test("rejects a value count that is not 8", () => {
    const { dv, u8 } = build([1, 2, 3, 4], { count: 4 });
    expect(findTransform(dv, u8, 0, u8.length)).toBeNull();
  });

  test("rejects non-double value types", () => {
    const { dv, u8 } = build([1, 2, 3, 4, 5, 6, 7, 8], { type: "long" });
    expect(findTransform(dv, u8, 0, u8.length)).toBeNull();
  });

  test("returns null when no Trnf key is present", () => {
    const u8 = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
    expect(findTransform(new DataView(u8.buffer), u8, 0, u8.length)).toBeNull();
  });
});
