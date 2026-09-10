import { describe, expect, test } from "vitest";
import sharp from "sharp";
import { RenderPool } from "../render-pool";
import type { RenderJobInput } from "../render-types";
import { coerceCalibration } from "../validate";

const ab = (b: Buffer): ArrayBuffer =>
  b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;

const flatPng = (w: number, h: number, rgb: [number, number, number]) =>
  sharp({
    create: { width: w, height: h, channels: 4, background: { r: rgb[0], g: rgb[1], b: rgb[2], alpha: 1 } },
  })
    .png()
    .toBuffer();

const jobFor = (mock: Buffer, design: Buffer): RenderJobInput => ({
  mock: ab(mock),
  design: ab(design),
  areaDesigns: null,
  overlays: [],
  calibration: coerceCalibration({
    qs: [
      [
        [0.25, 0.25],
        [0.75, 0.25],
        [0.75, 0.75],
        [0.25, 0.75],
      ],
    ],
    shade: 20,
    disp: 6,
  }),
  format: "jpeg",
  targetMin: 0.02 * 1024 * 1024,
  targetMax: 0.09 * 1024 * 1024,
});

describe("RenderPool", () => {
  test(
    "composes and encodes jobs end to end across workers",
    async () => {
      const W = 240;
      const H = 200;
      const mock = await flatPng(W, H, [80, 95, 110]);
      const design = await flatPng(90, 90, [230, 20, 20]);

      const pool = new RenderPool(2);
      try {
        const [a, b, c] = await Promise.all([
          pool.run(jobFor(mock, design)),
          pool.run(jobFor(mock, design)),
          pool.run({ ...jobFor(mock, design), format: "png" }),
        ]);

        expect(a.ok && b.ok && c.ok).toBe(true);
        if (a.ok) {
          expect(a.ext).toBe("jpg");
          const u8 = new Uint8Array(a.bytes);
          expect([u8[0], u8[1], u8[2]]).toEqual([0xff, 0xd8, 0xff]);
          const meta = await sharp(Buffer.from(a.bytes)).metadata();
          expect([meta.width, meta.height]).toEqual([W, H]);
        }
        if (c.ok) {
          expect(c.ext).toBe("png");
          expect(new Uint8Array(c.bytes).slice(0, 4)).toEqual(
            new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
          );
        }
        expect(pool.workerCount).toBeGreaterThan(0);
        expect(pool.workerCount).toBeLessThanOrEqual(2);
      } finally {
        await pool.close();
      }
    },
    30_000,
  );

  test("rejects new work once closed", async () => {
    const pool = new RenderPool(1);
    await pool.close();
    const mock = await flatPng(8, 8, [10, 10, 10]);
    const res = await pool.run(jobFor(mock, mock));
    expect(res.ok).toBe(false);
  });
});
