import { describe, expect, test } from "vitest";
import { applyPriceAdjustment, parsePriceAdjustment } from "@/lib/etsy/price-adjustment";

describe("parsePriceAdjustment", () => {
  test("parses a plain fixed amount", () => {
    expect(parsePriceAdjustment("2.00")).toEqual({ kind: "fixed", amount: 2 });
  });

  test("parses an explicit positive fixed amount", () => {
    expect(parsePriceAdjustment("+2.5")).toEqual({ kind: "fixed", amount: 2.5 });
  });

  test("parses a negative fixed amount", () => {
    expect(parsePriceAdjustment("-2.00")).toEqual({ kind: "fixed", amount: -2 });
  });

  test("parses a positive percentage", () => {
    expect(parsePriceAdjustment("10%")).toEqual({ kind: "percent", amount: 10 });
  });

  test("parses a negative percentage", () => {
    expect(parsePriceAdjustment("-10%")).toEqual({ kind: "percent", amount: -10 });
  });

  test("tolerates surrounding whitespace", () => {
    expect(parsePriceAdjustment("  +5%  ")).toEqual({ kind: "percent", amount: 5 });
  });

  test("rejects garbage input", () => {
    expect(parsePriceAdjustment("abc")).toBeNull();
    expect(parsePriceAdjustment("")).toBeNull();
    expect(parsePriceAdjustment("10%%")).toBeNull();
    expect(parsePriceAdjustment("$10")).toBeNull();
  });
});

describe("applyPriceAdjustment", () => {
  test("adds a fixed amount", () => {
    expect(applyPriceAdjustment(20, { kind: "fixed", amount: 2 })).toBe(22);
  });

  test("subtracts a fixed amount", () => {
    expect(applyPriceAdjustment(20, { kind: "fixed", amount: -5 })).toBe(15);
  });

  test("applies a positive percentage", () => {
    expect(applyPriceAdjustment(20, { kind: "percent", amount: 10 })).toBe(22);
  });

  test("applies a negative percentage", () => {
    expect(applyPriceAdjustment(20, { kind: "percent", amount: -10 })).toBe(18);
  });

  test("rounds to two decimals", () => {
    expect(applyPriceAdjustment(19.99, { kind: "percent", amount: 10 })).toBe(21.99); // 21.989 -> 21.99
    expect(applyPriceAdjustment(10, { kind: "fixed", amount: 0.001 })).toBe(10);
  });

  test("never goes negative", () => {
    expect(applyPriceAdjustment(5, { kind: "fixed", amount: -100 })).toBe(0);
    expect(applyPriceAdjustment(5, { kind: "percent", amount: -1000 })).toBe(0);
  });
});
