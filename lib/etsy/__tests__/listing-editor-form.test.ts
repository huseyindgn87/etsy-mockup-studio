import { describe, expect, it } from "vitest";
import { listingFormFromSource, sourceFromCache, type CachedListingRow } from "@/lib/etsy/listing-editor-form";

const row = (overrides: Partial<CachedListingRow> = {}): CachedListingRow => ({
  listingId: "1",
  title: "Tee",
  description: "Soft.",
  tags: ["tee"],
  quantity: 5,
  sku: "SKU-1",
  shopSectionId: 9,
  whoMade: "collective",
  whenMade: "2020_2026",
  isSupply: true,
  priceAmount: 1999,
  priceDivisor: 100,
  isPersonalizable: false,
  personalizationIsRequired: false,
  personalizationInstructions: null,
  personalizationCharCountMax: null,
  inventoryProperties: [],
  inventoryProducts: [],
  ...overrides,
});

const product = (valueIds: string[], o: Partial<CachedListingRow["inventoryProducts"][number]> = {}) => ({
  sku: "SKU-1",
  priceAmount: 1999,
  priceDivisor: 100,
  quantity: 5,
  isEnabled: true,
  readinessStateId: "77",
  values: valueIds.map((valueId) => ({ valueId })),
  ...o,
});

describe("listingFormFromSource", () => {
  it("maps a listing without variations", () => {
    const form = listingFormFromSource(
      sourceFromCache(row({ inventoryProducts: [product([], { quantity: 4, sku: "GRID-SKU" })] })),
    );
    expect(form).toMatchObject({
      title: "Tee",
      description: "Soft.",
      tags: ["tee"],
      price: "19.99",
      quantity: "4",
      sku: "GRID-SKU",
      readinessStateId: 77,
      shopSectionId: 9,
      whoMade: "collective",
      whenMade: "2020_2026",
      isSupply: true,
      variations: [],
    });
    expect(form.variationToggles.price.enabled).toBe(false);
  });

  it("maps a variation grid, inferring which variation the processing profile depends on", () => {
    const form = listingFormFromSource(
      sourceFromCache(
        row({
          inventoryProperties: [
            {
              etsyPropertyId: "513",
              name: "Size",
              scaleId: null,
              rank: 0,
              priceOnProperty: false,
              quantityOnProperty: true,
              skuOnProperty: false,
              values: [
                { id: "s", etsyValueId: "11", value: "S", rank: 0 },
                { id: "l", etsyValueId: null, value: "L", rank: 1 },
              ],
            },
            {
              etsyPropertyId: "200",
              name: "Color",
              scaleId: null,
              rank: 1,
              priceOnProperty: false,
              quantityOnProperty: false,
              skuOnProperty: false,
              values: [
                { id: "red", etsyValueId: "21", value: "Red", rank: 0 },
                { id: "blue", etsyValueId: "22", value: "Blue", rank: 1 },
              ],
            },
          ],
          inventoryProducts: [
            product(["s", "red"], { quantity: 1, readinessStateId: "70" }),
            product(["s", "blue"], { quantity: 1, readinessStateId: "71" }),
            product(["l", "red"], { quantity: 2, readinessStateId: "70" }),
            product(["l", "blue"], { quantity: 2, readinessStateId: "71", isEnabled: false }),
          ],
        }),
      ),
    );
    expect(form.variations).toEqual([
      { propertyId: 513, name: "Size", isCustom: true, valueIds: [11, -1], values: ["S", "L"], linksPhotos: false },
      { propertyId: 200, name: "Color", isCustom: false, valueIds: [21, 22], values: ["Red", "Blue"], linksPhotos: false },
    ]);
    expect(form.variationToggles.quantity).toEqual({ enabled: true, appliesTo: [0] });
    expect(form.variationRows.quantity).toEqual({ "11": "1", "-1": "2" });
    expect(form.variationToggles.readiness).toEqual({ enabled: true, appliesTo: [1] });
    expect(form.variationRows.readiness).toEqual({ "21": "70", "22": "71" });
    expect(form.variationToggles.price.enabled).toBe(false);
    expect(form.price).toBe("19.99");
    expect(form.variationRowEnabled).toEqual({ "-1:22": false });
  });
});
