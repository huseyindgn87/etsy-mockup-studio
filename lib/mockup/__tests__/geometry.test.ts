import { expect, test } from "vitest";
import {
  containFit,
  homography,
  pointInQuad,
  quadList,
  quadMetrics,
  quadToPx,
  rotateQuad,
} from "../geometry";
import type { Quad } from "../types";

const FULL: Quad = [
  [0, 0],
  [1, 0],
  [1, 1],
  [0, 1],
];

function invMap(Hi: number[], x: number, y: number): [number, number] {
  const w = Hi[6] * x + Hi[7] * y + Hi[8];
  return [(Hi[0] * x + Hi[1] * y + Hi[2]) / w, (Hi[3] * x + Hi[4] * y + Hi[5]) / w];
}

test("homography of an axis-aligned quad is a plain scale", () => {
  const Hi = homography(quadToPx(FULL, 100, 100));
  expect(invMap(Hi, 0, 0)[0]).toBeCloseTo(0, 6);
  expect(invMap(Hi, 100, 100)[0]).toBeCloseTo(1, 6);
  const [u, v] = invMap(Hi, 50, 50);
  expect(u).toBeCloseTo(0.5, 6);
  expect(v).toBeCloseTo(0.5, 6);
});

test("homography maps a sheared quad's corners back to unit corners", () => {
  const q: Quad = [
    [10, 20],
    [90, 5],
    [95, 85],
    [5, 70],
  ];
  const Hi = homography(q);
  const corners: [number, number][] = [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1],
  ];
  q.forEach((p, k) => {
    const [u, v] = invMap(Hi, p[0], p[1]);
    expect(u).toBeCloseTo(corners[k][0], 4);
    expect(v).toBeCloseTo(corners[k][1], 4);
  });
});

test("quadList promotes a legacy single quad and passes through a list", () => {
  expect(quadList({ q: FULL })).toEqual([FULL]);
  const two = [FULL, FULL] as Quad[];
  expect(quadList({ qs: two })).toBe(two);
});

test("rotateQuad by 90 degrees cycles the corners", () => {
  const q: Quad = [
    [0.25, 0.25],
    [0.75, 0.25],
    [0.75, 0.75],
    [0.25, 0.75],
  ];
  const r = rotateQuad(q, 90, 100, 100);
  expect(r[0][0]).toBeCloseTo(q[1][0], 6);
  expect(r[0][1]).toBeCloseTo(q[1][1], 6);
});

test("rotateQuad by 360 degrees is identity", () => {
  const q: Quad = [
    [0.2, 0.3],
    [0.8, 0.25],
    [0.85, 0.9],
    [0.15, 0.8],
  ];
  const r = rotateQuad(q, 360, 640, 480);
  q.forEach((p, k) => {
    expect(r[k][0]).toBeCloseTo(p[0], 6);
    expect(r[k][1]).toBeCloseTo(p[1], 6);
  });
});

test("containFit centres a wide design and leaves vertical margin", () => {
  const f = containFit(200, 100, 1, 1);
  expect(f.uw).toBeCloseTo(1, 6);
  expect(f.uh).toBeCloseTo(0.5, 6);
  expect(f.vOff).toBeCloseTo(0.25, 6);
});

test("quadMetrics of a 100px square", () => {
  const m = quadMetrics(quadToPx(FULL, 100, 100));
  expect(m.w).toBeCloseTo(100, 6);
  expect(m.h).toBeCloseTo(100, 6);
  expect(m.ar).toBeCloseTo(1, 6);
});

test("pointInQuad", () => {
  const qPx = quadToPx(FULL, 100, 100);
  expect(pointInQuad([50, 50], qPx)).toBe(true);
  expect(pointInQuad([150, 50], qPx)).toBe(false);
});
