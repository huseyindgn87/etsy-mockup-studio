import { expect, test } from "vitest";
import {
  assignMap,
  colorFromName,
  colorFromRGB,
  fits,
  fitsArea,
  measureTone,
} from "../tone";
import type { Calibration, Quad } from "../types";
import { solid } from "./helpers";

test("measureTone reads ink tone from luminance", () => {
  expect(measureTone(solid(64, 64, 20, 20, 20), { isMock: false, name: "a.png" }).tone).toBe(
    "dark",
  );
  expect(measureTone(solid(64, 64, 240, 240, 240), { isMock: false, name: "a.png" }).tone).toBe(
    "light",
  );
});

test("measureTone filename hints override luminance for designs", () => {
  const midGrey = solid(64, 64, 130, 130, 130);
  expect(measureTone(midGrey, { isMock: false, name: "white-logo.png" }).tone).toBe("light");
  expect(measureTone(midGrey, { isMock: false, name: "siyah baski.png" }).tone).toBe("dark");
});

test("measureTone for a mockup matches the swatch chart", () => {
  const r = measureTone(solid(64, 64, 30, 30, 30), { isMock: true, name: "shirt.png" });
  expect(r.tone).toBe("dark");
  expect(r.src).toBe("ölçüm");
  expect(r.matched).toBe("Black");
});

test("measureTone for a mockup prefers a colour name in the filename", () => {
  const r = measureTone(solid(64, 64, 90, 90, 90), {
    isMock: true,
    name: "Comfort Colors 1717 White front.jpg",
  });
  expect(r.tone).toBe("light");
  expect(r.src).toBe("ad");
});

test("colorFromName / colorFromRGB", () => {
  expect(colorFromName("gildan 5000 black.jpg")?.tone).toBe("dark");
  expect(colorFromName("nope.jpg")).toBeNull();
  expect(colorFromRGB(0, 0, 0).tone).toBe("dark");
  expect(colorFromRGB(255, 255, 255).tone).toBe("light");
});

test("fits pairs opposite tones only when auto pairing is on", () => {
  expect(fits({ tone: "dark" }, { tone: "light" }, true)).toBe(true);
  expect(fits({ tone: "dark" }, { tone: "dark" }, true)).toBe(false);
  expect(fits({ tone: "dark" }, { tone: "dark" }, false)).toBe(true);
  expect(fits({ tone: null }, { tone: "dark" }, true)).toBe(true);
});

test("fitsArea mirrors fits for a measured fabric tone", () => {
  expect(fitsArea({ tone: "dark" }, { tone: "light" })).toBe(true);
  expect(fitsArea({ tone: "dark" }, { tone: "dark" })).toBe(false);
  expect(fitsArea(null, { tone: "dark" })).toBe(true);
});

test("assignMap fills areas by fabric tone", () => {
  const c: Calibration = {
    shade: 15,
    disp: 10,
    dispR: 12,
    zoom: 100,
    rot: 0,
    b1: 0,
    b2: 0,
    w1: 255,
    w2: 255,
    amap: [],
    aset: [],
  };
  const areas: Quad[] = [
    [
      [0, 0],
      [0.5, 0],
      [0.5, 1],
      [0, 1],
    ],
    [
      [0.5, 0],
      [1, 0],
      [1, 1],
      [0.5, 1],
    ],
  ];
  const designs = [{ tone: "light" as const }, { tone: "dark" as const }];
  const toneByArea = new Map<Quad, { tone: "dark" | "light" }>([
    [areas[0], { tone: "dark" }],
    [areas[1], { tone: "light" }],
  ]);
  const map = assignMap(c, areas, designs, (a) => toneByArea.get(a) ?? null);
  expect(map).toEqual([0, 1]);
});

test("assignMap keeps hand-set entries", () => {
  const c: Calibration = {
    shade: 15,
    disp: 10,
    dispR: 12,
    zoom: 100,
    rot: 0,
    b1: 0,
    b2: 0,
    w1: 255,
    w2: 255,
    amap: [1, -1],
    aset: [true, false],
  };
  const areas: Quad[] = [
    [
      [0, 0],
      [1, 0],
      [1, 0.5],
      [0, 0.5],
    ],
    [
      [0, 0.5],
      [1, 0.5],
      [1, 1],
      [0, 1],
    ],
  ];
  const designs = [{ tone: "light" as const }, { tone: "dark" as const }];
  const map = assignMap(c, areas, designs, () => null);
  expect(map[0]).toBe(1);
});
