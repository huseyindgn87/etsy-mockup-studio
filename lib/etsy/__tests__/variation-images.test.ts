import { describe, expect, test } from "vitest";
import { resolveVariationImageValueIds } from "@/lib/etsy/publish-listing";
import { resolveVariationImages } from "@/lib/etsy/variation-images";

/** Color with Red/Blue, as Etsy returns the inventory. */
const inventory = (red: number, blue: number) => ({
  products: [
    { property_values: [{ property_id: 200, value_ids: [red], values: ["Red"] }] },
    { property_values: [{ property_id: 200, value_ids: [blue], values: ["Blue"] }] },
  ],
});

describe("resolveVariationImages", () => {
  test("uses the value ids of the inventory it's given, not the ids the editor last saw", () => {
    const result = resolveVariationImages(
      [
        { propertyId: 200, valueId: 1, value: "Red", imageId: 900 },
        { propertyId: 200, valueId: null, value: "Blue", imageId: 901 },
      ],
      inventory(5551, 5552),
      [900, 901],
    );
    expect(result).toEqual({
      ok: true,
      images: [
        { propertyId: 200, valueId: 5551, imageId: 900 },
        { propertyId: 200, valueId: 5552, imageId: 901 },
      ],
    });
  });

  test("falls back to the old id only when that id is still in the inventory", () => {
    const renamed = { products: [{ property_values: [{ property_id: 200, value_ids: [1], values: ["Crimson"] }] }] };
    expect(resolveVariationImages([{ propertyId: 200, valueId: 1, value: "Red", imageId: 900 }], renamed, [900])).toEqual({
      ok: true,
      images: [{ propertyId: 200, valueId: 1, imageId: 900 }],
    });
    expect(
      resolveVariationImages([{ propertyId: 200, valueId: 1, value: "Red", imageId: 900 }], inventory(7, 8), [900]),
    ).toEqual({ ok: true, images: [{ propertyId: 200, valueId: 7, imageId: 900 }] });
    const gone = { products: [{ property_values: [{ property_id: 200, value_ids: [3], values: ["Green"] }] }] };
    expect(resolveVariationImages([{ propertyId: 200, valueId: 1, value: "Red", imageId: 900 }], gone, [900])).toEqual({
      ok: false,
      error: "“Red” is no longer an option on the listing.",
    });
  });

  test("refuses assignments on more than one property", () => {
    const twoProps = {
      products: [
        {
          property_values: [
            { property_id: 100, value_ids: [11], values: ["S"] },
            { property_id: 200, value_ids: [1], values: ["Red"] },
          ],
        },
      ],
    };
    expect(
      resolveVariationImages(
        [
          { propertyId: 100, valueId: 11, value: "S", imageId: 900 },
          { propertyId: 200, valueId: 1, value: "Red", imageId: 901 },
        ],
        twoProps,
        [900, 901],
      ),
    ).toEqual({ ok: false, error: "Photos can vary by one variation only." });
  });

  test("refuses a photo that isn't on the listing instead of dropping it", () => {
    expect(
      resolveVariationImages([{ propertyId: 200, valueId: 1, value: "Red", imageId: 999 }], inventory(1, 2), [900]),
    ).toEqual({ ok: false, error: "The photo chosen for “Red” is no longer on the listing." });
  });

  test("refuses two different photos for one value, and collapses an exact repeat", () => {
    const red = { propertyId: 200, valueId: 1, value: "Red", imageId: 900 };
    expect(resolveVariationImages([red, { ...red, imageId: 901 }], inventory(1, 2), [900, 901])).toEqual({
      ok: false,
      error: "“Red” was given two photos.",
    });
    expect(resolveVariationImages([red, red], inventory(1, 2), [900])).toEqual({
      ok: true,
      images: [{ propertyId: 200, valueId: 1, imageId: 900 }],
    });
  });

  test("an empty set resolves to an empty request — the cleared state", () => {
    expect(resolveVariationImages([], {}, [])).toEqual({ ok: true, images: [] });
  });
});

describe("resolveVariationImageValueIds (the listing editor's publish)", () => {
  test("never sends a pre-update id the saved inventory doesn't have", () => {
    const images = [
      { propertyId: 200, valueId: 1, value: "Red", imageIndex: 0 },
      { propertyId: 200, valueId: 2, value: "Gone", imageIndex: 1 },
    ];
    expect(resolveVariationImageValueIds(images, inventory(5551, 5552))).toEqual([
      { propertyId: 200, valueId: 5551, value: "Red", imageIndex: 0 },
    ]);
  });
});
