import { describe, expect, test } from "vitest";
import { appendToList, applyTextTransform, isTextTransformMode } from "@/lib/etsy/bulk-text";

describe("add before / add after", () => {
  test("puts the text on the chosen side, separated by one space", () => {
    expect(applyTextTransform("Mug", { mode: "before", value: "Handmade" })).toBe("Handmade Mug");
    expect(applyTextTransform("Mug", { mode: "after", value: "— Gift" })).toBe("Mug — Gift");
  });

  test("an empty current value simply becomes the added text", () => {
    expect(applyTextTransform("", { mode: "before", value: "Handmade" })).toBe("Handmade");
    expect(applyTextTransform("", { mode: "after", value: "Handmade" })).toBe("Handmade");
  });

  test("adding nothing leaves the text exactly as it was", () => {
    expect(applyTextTransform("Mug", { mode: "before", value: "" })).toBe("Mug");
    expect(applyTextTransform("Mug", { mode: "after", value: "" })).toBe("Mug");
  });
});

describe("find and replace", () => {
  test("replaces every occurrence", () => {
    expect(
      applyTextTransform("Red mug, red lid", { mode: "replace", value: "Blue", find: "red" }),
    ).toBe("Red mug, Blue lid");
  });

  test("text that doesn't contain the search is untouched", () => {
    expect(applyTextTransform("Mug", { mode: "replace", value: "X", find: "zzz" })).toBe("Mug");
  });

  test("an empty search is a no-op rather than inserting everywhere", () => {
    expect(applyTextTransform("Mug", { mode: "replace", value: "X", find: "" })).toBe("Mug");
  });

  test("replacing with nothing removes the found text — the one way text shrinks", () => {
    expect(applyTextTransform("Red mug", { mode: "replace", value: "", find: "Red " })).toBe("mug");
  });
});

describe("appending to a list never clears it", () => {
  const limits = { max: 13, trimTo: 20 };

  test("keeps every existing entry and adds the new one at the end", () => {
    expect(appendToList(["gift", "mug"], "handmade", limits)).toEqual(["gift", "mug", "handmade"]);
  });

  test("a duplicate (any case) leaves the list exactly as it was", () => {
    expect(appendToList(["Gift", "mug"], "gift", limits)).toEqual(["Gift", "mug"]);
  });

  test("a blank entry leaves the list exactly as it was", () => {
    expect(appendToList(["gift"], "   ", limits)).toEqual(["gift"]);
  });

  test("a full list keeps its entries rather than evicting one to make room", () => {
    const full = Array.from({ length: 13 }, (_, i) => `tag${i}`);
    expect(appendToList(full, "one-more", limits)).toEqual(full);
  });

  test("an over-long entry is trimmed, not rejected", () => {
    expect(appendToList([], "x".repeat(30), limits)).toEqual(["x".repeat(20)]);
  });

  test("the result is a copy — the caller's list is never mutated", () => {
    const original = ["gift"];
    appendToList(original, "mug", limits);
    expect(original).toEqual(["gift"]);
  });
});

describe("mode guard", () => {
  test("accepts only the three documented modes", () => {
    expect(isTextTransformMode("before")).toBe(true);
    expect(isTextTransformMode("after")).toBe(true);
    expect(isTextTransformMode("replace")).toBe(true);
    expect(isTextTransformMode("delete")).toBe(false);
  });
});
