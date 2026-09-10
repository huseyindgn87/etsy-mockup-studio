import { describe, expect, test } from "vitest";
import { searchJpegQuality } from "../encode-search";

/** Fake encoder: byte size grows smoothly with quality. */
const linear = (atZero: number, atOne: number) => (q: number) =>
  Promise.resolve(atZero + (atOne - atZero) * q);

describe("searchJpegQuality", () => {
  test("converges into the target window", async () => {
    // reachable within the 0.60–0.98 bracket: size(0.6)=1.2M, size(0.98)≈1.96M
    const calls: number[] = [];
    const encode = (q: number) => {
      calls.push(q);
      return linear(0, 2_000_000)(q);
    };
    const res = await searchJpegQuality(encode, { min: 1_200_000, max: 1_700_000 });
    expect(res.inRange).toBe(true);
    expect(res.size).toBeGreaterThanOrEqual(1_200_000);
    expect(res.size).toBeLessThanOrEqual(1_700_000);
    expect(res.quality).toBeGreaterThan(0.6);
    expect(res.quality).toBeLessThan(0.98);
    expect(calls.length).toBeLessThanOrEqual(8);
  });

  test("everything overshoots max → returns the smallest trial", async () => {
    const res = await searchJpegQuality(linear(5_000_000, 9_000_000), {
      min: 1_000_000,
      max: 2_000_000,
      steps: 6,
    });
    expect(res.inRange).toBe(false);
    // smallest comes from the lowest quality the bisection tries (mid of 0.60..0.98)
    expect(res.size).toBeLessThan(9_000_000);
    expect(res.quality).toBeLessThanOrEqual(0.79);
  });

  test("everything undershoots min → returns the largest trial", async () => {
    const res = await searchJpegQuality(linear(10_000, 90_000), {
      min: 1_000_000,
      max: 2_000_000,
      steps: 5,
    });
    expect(res.inRange).toBe(false);
    expect(res.quality).toBeGreaterThan(0.79); // pushed toward the top of the bracket
  });

  test("honours the step budget", async () => {
    let n = 0;
    await searchJpegQuality(
      (q) => {
        n++;
        return linear(9_000_000, 9_000_000)(q);
      },
      { min: 1, max: 2, steps: 3 },
    );
    expect(n).toBe(3);
  });
});
