import { expect, test } from "vitest";
import { compositePixel, drawOverlays, PSD_BLEND } from "../blend";
import type { Overlay } from "../types";
import { px, solid } from "./helpers";

function one(bg: [number, number, number, number]) {
  return new Uint8ClampedArray(bg);
}

test("source-over, opaque over opaque, replaces the backdrop", () => {
  const d = one([10, 20, 30, 255]);
  compositePixel(d, 0, 200, 100, 50, 1, "source-over");
  expect([...d]).toEqual([200, 100, 50, 255]);
});

test("source-over at half alpha is a linear mix", () => {
  const d = one([0, 0, 0, 255]);
  compositePixel(d, 0, 200, 100, 50, 0.5, "source-over");
  expect(Math.abs(d[0] - 100)).toBeLessThanOrEqual(1);
  expect(Math.abs(d[1] - 50)).toBeLessThanOrEqual(1);
  expect(Math.abs(d[2] - 25)).toBeLessThanOrEqual(1);
});

test("multiply darkens (0.5 x 0.5 = 0.25)", () => {
  const d = one([128, 128, 128, 255]);
  compositePixel(d, 0, 128, 128, 128, 1, "multiply");
  expect(d[0]).toBeGreaterThanOrEqual(63);
  expect(d[0]).toBeLessThanOrEqual(65);
});

test("screen lightens (0.5 screen 0.5 = 0.75)", () => {
  const d = one([128, 128, 128, 255]);
  compositePixel(d, 0, 128, 128, 128, 1, "screen");
  expect(d[0]).toBeGreaterThanOrEqual(190);
  expect(d[0]).toBeLessThanOrEqual(192);
});

test("lighter adds channels", () => {
  const d = one([100, 100, 100, 255]);
  compositePixel(d, 0, 100, 100, 100, 1, "lighter");
  expect(d[0]).toBeGreaterThanOrEqual(199);
  expect(d[0]).toBeLessThanOrEqual(200);
});

test("hard-light with cs<=0.5 behaves like multiply(cb, 2cs)", () => {
  const d = one([128, 128, 128, 255]);
  compositePixel(d, 0, 64, 64, 64, 1, "hard-light"); // 2*0.25 = 0.5 → multiply(0.5,0.5)=0.25
  expect(d[0]).toBeGreaterThanOrEqual(63);
  expect(d[0]).toBeLessThanOrEqual(65);
});

test("PSD_BLEND maps the keys the parser emits", () => {
  expect(PSD_BLEND["norm"]).toBe("source-over");
  expect(PSD_BLEND["mul "]).toBe("multiply");
  expect(PSD_BLEND["lddg"]).toBe("lighter");
});

test("drawOverlays paints a full-cover opaque layer", () => {
  const dest = solid(8, 8, 128, 128, 128, 255);
  const ov: Overlay = {
    data: solid(8, 8, 255, 0, 0, 255).data,
    x: 0,
    y: 0,
    w: 8,
    h: 8,
    blend: "source-over",
    alpha: 1,
    clip: false,
    name: "top",
  };
  drawOverlays(dest, [ov], 8, 8, 8, 8);
  expect(px(dest, 4, 4)).toEqual([255, 0, 0, 255]);
});

test("drawOverlays at half opacity blends toward the layer", () => {
  const dest = solid(4, 4, 0, 0, 0, 255);
  const ov: Overlay = {
    data: solid(4, 4, 255, 255, 255, 255).data,
    x: 0,
    y: 0,
    w: 4,
    h: 4,
    blend: "source-over",
    alpha: 0.5,
    clip: false,
    name: "top",
  };
  drawOverlays(dest, [ov], 4, 4, 4, 4);
  expect(px(dest, 1, 1)[0]).toBeGreaterThanOrEqual(126);
  expect(px(dest, 1, 1)[0]).toBeLessThanOrEqual(129);
});
