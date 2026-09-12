import { describe, expect, test } from "vitest";
import { draftAssetKey, draftPrefix } from "@/lib/storage/r2";

describe("draftAssetKey", () => {
  test("builds a deterministic key per draft/kind/item", () => {
    expect(draftAssetKey("d1", "psd", "m1")).toBe("drafts/d1/psd/m1");
    expect(draftAssetKey("d1", "design", "des1")).toBe("drafts/d1/design/des1");
    expect(draftAssetKey("d1", "own", "o1")).toBe("drafts/d1/own/o1");
    expect(draftAssetKey("d1", "thumbnail", "thumb")).toBe("drafts/d1/thumbnail/thumb");
  });

  test("is stable for the same inputs (so re-upload replaces, not duplicates)", () => {
    expect(draftAssetKey("d1", "psd", "m1")).toBe(draftAssetKey("d1", "psd", "m1"));
  });
});

describe("draftPrefix", () => {
  test("matches the prefix every asset key for that draft falls under", () => {
    const prefix = draftPrefix("d1");
    expect(prefix).toBe("drafts/d1/");
    expect(draftAssetKey("d1", "psd", "m1").startsWith(prefix)).toBe(true);
    expect(draftAssetKey("d1", "design", "des1").startsWith(prefix)).toBe(true);
  });

  test("doesn't match a different draft's keys", () => {
    const prefix = draftPrefix("d1");
    expect(draftAssetKey("d2", "psd", "m1").startsWith(prefix)).toBe(false);
  });
});
