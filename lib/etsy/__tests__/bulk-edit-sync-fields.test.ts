import { describe, expect, it } from "vitest";
import { listingUpdateForm } from "@/lib/etsy/bulk-apply";
import { parseBulkPatch } from "@/lib/etsy/bulk-edit";

describe("fields the editor's Sync to Etsy added to the bulk patch", () => {
  it("featured position: accepted when 1 or more, written as featured_rank", () => {
    const parsed = parseBulkPatch({ featuredRank: 1 });
    expect(parsed).toEqual({ ok: true, value: { featuredRank: 1 } });
    expect(listingUpdateForm({ featuredRank: 1 }).get("featured_rank")).toBe("1");
    expect(parseBulkPatch({ featuredRank: 0 }).ok).toBe(false);
  });

  it("a variation property's scale survives parsing", () => {
    const parsed = parseBulkPatch({
      variations: {
        products: [
          { propertyValues: [{ propertyId: 100, name: "Size", valueIds: [11], values: ["S"], scaleId: 5 }], price: 20, quantity: 1, enabled: true },
        ],
        priceOnProperty: [],
        quantityOnProperty: [],
        skuOnProperty: [],
        readinessStateOnProperty: [],
      },
    });
    expect(parsed.ok && parsed.value.variations?.products[0].propertyValues[0].scaleId).toBe(5);
  });
});
