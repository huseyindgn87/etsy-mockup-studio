import { expect, test } from "vitest";
import { compose, stampQuad } from "../compose";
import type { Calibration, Overlay, Quad } from "../types";
import { px, solid } from "./helpers";

const FULL: Quad = [
  [0, 0],
  [1, 0],
  [1, 1],
  [0, 1],
];

const flat: Calibration = {
  qs: [FULL],
  ai: 0,
  shade: 0,
  disp: 0,
  dispR: 12,
  zoom: 100,
  rot: 0,
  b1: 0,
  b2: 0,
  w1: 255,
  w2: 255,
};

test("stampQuad lays an opaque design over the full area with no shading", () => {
  const mock = solid(8, 8, 128, 128, 128, 255);
  const design = solid(4, 4, 255, 255, 255, 255);
  const wrote = stampQuad(mock.data, design.data, 4, 4, flat, 8, 8, FULL);
  expect(wrote).toBe(true);
  expect(px(mock, 4, 4)).toEqual([255, 255, 255, 255]);
});

test("stampQuad with a transparent design writes nothing", () => {
  const mock = solid(6, 6, 100, 110, 120, 255);
  const design = solid(4, 4, 255, 255, 255, 0);
  stampQuad(mock.data, design.data, 4, 4, flat, 6, 6, FULL);
  expect(px(mock, 3, 3)).toEqual([100, 110, 120, 255]);
});

test("shading multiplies the design by local/mean fabric luminance", () => {
  // left half of the mock dark, right half light → shade pushes the design
  // darker on the left, brighter on the right
  const mock = solid(8, 8, 255, 255, 255, 255);
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 4; x++) {
      const i = (y * 8 + x) * 4;
      mock.data[i] = mock.data[i + 1] = mock.data[i + 2] = 60;
    }
  }
  const design = solid(8, 8, 128, 128, 128, 255);
  stampQuad(mock.data, design.data, 8, 8, { ...flat, shade: 100 }, 8, 8, FULL);
  expect(px(mock, 1, 4)[0]).toBeLessThan(px(mock, 6, 4)[0]);
});

test("compose lays the mock, stamps the design, then the overlay", () => {
  const mock = solid(8, 8, 90, 90, 90, 255);
  const design = solid(4, 4, 10, 200, 10, 255);
  const overlay: Overlay = {
    data: solid(8, 8, 0, 0, 255, 255).data,
    x: 0,
    y: 0,
    w: 8,
    h: 8,
    blend: "source-over",
    alpha: 1,
    clip: false,
    name: "top",
  };
  const out = compose(
    { mock, design, calibration: flat, overlays: [overlay] },
    8,
    8,
  );
  // overlay is opaque and covers everything → final pixel is the overlay colour
  expect(px(out, 4, 4)).toEqual([0, 0, 255, 255]);
});

test("compose with no design still returns the mock plus overlays", () => {
  const mock = solid(4, 4, 120, 130, 140, 255);
  const out = compose({ mock, design: null, calibration: flat }, 4, 4);
  expect(px(out, 2, 2)).toEqual([120, 130, 140, 255]);
});

test("compose upscales a smaller mock to the requested size", () => {
  const mock = solid(2, 2, 200, 100, 50, 255);
  const out = compose({ mock, design: null, calibration: flat }, 16, 16);
  expect(out.width).toBe(16);
  expect(px(out, 8, 8)).toEqual([200, 100, 50, 255]);
});
