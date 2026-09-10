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

// mock with a sinusoidal fold pattern (normalised frequency) → wrinkle-map
// gradients that actually vary across the print area
function folds(S: number): ReturnType<typeof solid> {
  const r = solid(S, S, 0, 0, 0, 255);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const i = (y * S + x) * 4;
      const v = 128 + 90 * Math.sin((x / S) * Math.PI * 6) * Math.cos((y / S) * Math.PI * 5);
      const c = Math.max(0, Math.min(255, Math.round(v)));
      r.data[i] = r.data[i + 1] = r.data[i + 2] = c;
    }
  }
  return r;
}

// horizontal grey gradient → any displacement difference shows as a value shift
function gradientDesign(S: number): ReturnType<typeof solid> {
  const d = solid(S, S, 0, 0, 0, 255);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const i = (y * S + x) * 4;
      const v = Math.round((255 * x) / (S - 1));
      d.data[i] = d.data[i + 1] = d.data[i + 2] = v;
    }
  }
  return d;
}

const wrinkled: Calibration = {
  ...flat,
  qs: [
    [
      [0.2, 0.2],
      [0.8, 0.2],
      [0.8, 0.8],
      [0.2, 0.8],
    ],
  ],
  shade: 30,
  disp: 24,
  dispR: 18,
};

test("wrinkle displacement is resolution-independent (client/server parity)", () => {
  const design = gradientDesign(64);
  const N = 128;
  const small = compose({ mock: folds(N), design, calibration: wrinkled }, N, N);
  const large = compose({ mock: folds(2 * N), design, calibration: wrinkled }, 2 * N, 2 * N);

  // box-average `large` 2×2 down to N, then mean abs diff against `small`
  let sum = 0;
  let count = 0;
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      for (let k = 0; k < 3; k++) {
        let avg = 0;
        for (let dy = 0; dy < 2; dy++) {
          for (let dx = 0; dx < 2; dx++) {
            avg += large.data[((2 * y + dy) * 2 * N + (2 * x + dx)) * 4 + k];
          }
        }
        sum += Math.abs(avg / 4 - small.data[(y * N + x) * 4 + k]);
        count++;
      }
    }
  }
  expect(sum / count).toBeLessThan(6);
});

test("displacement parity test is not vacuous — disp actually moves pixels", () => {
  const design = gradientDesign(64);
  const N = 128;
  const on = compose({ mock: folds(N), design, calibration: wrinkled }, N, N);
  const off = compose(
    { mock: folds(N), design, calibration: { ...wrinkled, disp: 0 } },
    N,
    N,
  );
  let sum = 0;
  for (let i = 0; i < on.data.length; i++) sum += Math.abs(on.data[i] - off.data[i]);
  expect(sum / on.data.length).toBeGreaterThan(1);
});
