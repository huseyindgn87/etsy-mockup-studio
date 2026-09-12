import { describe, expect, test } from "vitest";
import { coercePhotosData } from "@/lib/drafts/validate";

describe("coercePhotosData", () => {
  test("passes through a well-formed record", () => {
    const input = {
      mockups: [{ id: "m1", name: "Tee", contentHash: "abc", calibration: {}, include: true }],
      designs: [{ id: "d1", name: "Logo" }],
      ownImages: [{ id: "o1", name: "photo.jpg" }],
      imageOrder: [{ kind: "job", key: "m1::d1" }],
      altTextBySlot: { "job:m1::d1": "A tee shirt" },
      activeTab: "variations",
    };
    expect(coercePhotosData(input)).toEqual(input);
  });

  test("defaults every field for null/undefined", () => {
    expect(coercePhotosData(null)).toEqual({
      mockups: [],
      designs: [],
      ownImages: [],
      imageOrder: [],
      altTextBySlot: {},
      activeTab: "photos",
    });
    expect(coercePhotosData(undefined)).toEqual(coercePhotosData(null));
  });

  test("drops non-array fields back to empty arrays rather than throwing", () => {
    const result = coercePhotosData({ mockups: "nope", designs: 42, ownImages: {} });
    expect(result.mockups).toEqual([]);
    expect(result.designs).toEqual([]);
    expect(result.ownImages).toEqual([]);
  });

  test("falls back activeTab to 'photos' when not a string", () => {
    expect(coercePhotosData({ activeTab: 5 }).activeTab).toBe("photos");
    expect(coercePhotosData({ activeTab: "title" }).activeTab).toBe("title");
  });

  test("falls back altTextBySlot to {} when not an object", () => {
    expect(coercePhotosData({ altTextBySlot: "nope" }).altTextBySlot).toEqual({});
    expect(coercePhotosData({ altTextBySlot: null }).altTextBySlot).toEqual({});
  });
});
