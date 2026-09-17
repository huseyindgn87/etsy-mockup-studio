import { describe, expect, test } from "vitest";
import { joinIdList, joinList } from "@/lib/etsy/form-list";

describe("joinList", () => {
  test("joins with commas into a single field value", () => {
    expect(joinList(["holiday", "gift", "mug"])).toBe("holiday,gift,mug");
  });

  test("keeps a single entry as itself, and an empty list as an empty string", () => {
    expect(joinList(["holiday"])).toBe("holiday");
    expect(joinList([])).toBe("");
  });

  test("drops a comma inside a value rather than splitting it into two entries", () => {
    expect(joinList(["red, white", "blue"])).toBe("red white,blue");
  });

  test("trims and skips blanks", () => {
    expect(joinList(["  gift  ", "", "   ", "mug"])).toBe("gift,mug");
  });
});

describe("joinIdList", () => {
  test("joins ids with commas", () => {
    expect(joinIdList([66, 67])).toBe("66,67");
    expect(joinIdList([])).toBe("");
  });
});
