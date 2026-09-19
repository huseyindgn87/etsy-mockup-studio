import { describe, expect, it } from "vitest";
import type { ListingFormValue } from "@/app/(app)/mockups/ListingForm";
import { editorSyncPatch, type EditorSyncPlan } from "@/lib/etsy/editor-sync";
import { listingFormFromSource, type EditorListingSource } from "@/lib/etsy/listing-editor-form";
import { gridToOfferingState } from "@/lib/etsy/variation-grid-form";
import type { VariationGrid } from "@/lib/etsy/variation-grid";

const SOURCE: EditorListingSource = {
  title: "Cat Tee",
  description: "Soft tee.",
  tags: ["cat shirt", "cat lover"],
  materials: ["cotton"],
  price: 20,
  quantity: 5,
  sku: "TEE-1",
  shopSectionId: 10,
  readinessStateId: 7,
  shippingProfileId: 55,
  returnPolicyId: 66,
  whoMade: "someone_else",
  whenMade: "made_to_order",
  isSupply: false,
  productionPartnerIds: [3],
  taxonomyId: 482,
  taxonomyPath: "Clothing > T-shirts",
  attributes: [{ propertyId: 200, propertyName: "Primary color", scaleId: null, valueIds: [1], values: ["Black"] }],
  personalizationQuestions: [],
  featured: false,
  autoRenew: true,
  inventory: null,
};

const PLAIN = listingFormFromSource(SOURCE);

const GRID: VariationGrid = {
  listingId: 1,
  properties: [
    { propertyId: 100, name: "Size", scaleId: 5, options: [{ valueId: 11, name: "S" }, { valueId: 12, name: "M" }] },
  ],
  combinations: [11, 12].map((id, i) => ({
    key: String(id),
    valueIds: [id],
    values: [["S", "M"][i]],
    price: 20,
    quantity: 5,
    sku: "TEE",
    enabled: true,
    readinessStateId: 7,
  })),
  priceOnProperty: [],
  quantityOnProperty: [],
  skuOnProperty: [],
  readinessStateOnProperty: [],
};
const WITH_GRID: ListingFormValue = {
  ...PLAIN,
  ...gridToOfferingState(GRID, { price: 20, quantity: 5, sku: "TEE", readinessStateId: 7 }, [
    { propertyId: 100, valueId: 11, value: "S", imageId: 900 },
  ]),
};

const plan = (original: ListingFormValue, current: Partial<ListingFormValue>): EditorSyncPlan => {
  const result = editorSyncPatch(original, { ...original, ...current });
  if ("error" in result) throw new Error(result.error);
  return result;
};

describe("editor sync — every field of the form counts", () => {
  it("an unchanged form has nothing to send and nothing unsynced", () => {
    expect(plan(PLAIN, {})).toEqual({ patch: {}, unsynced: [] });
    expect(plan(WITH_GRID, {})).toEqual({ patch: {}, unsynced: [] });
  });

  it.each<[string, Partial<ListingFormValue>, Record<string, unknown>]>([
    ["Title", { title: "Dog Tee" }, { title: "Dog Tee" }],
    ["Description", { description: "Softer." }, { description: "Softer." }],
    ["Tags", { tags: ["cat shirt"] }, { tags: ["cat shirt"] }],
    ["Tag order", { tags: ["cat lover", "cat shirt"] }, { tags: ["cat lover", "cat shirt"] }],
    ["Who made it", { whoMade: "i_did" }, { whoMade: "i_did", whenMade: "made_to_order", isSupply: false }],
    ["When made", { whenMade: "2020_2026" }, { whoMade: "someone_else", whenMade: "2020_2026", isSupply: false }],
    ["Supply", { isSupply: true }, { whoMade: "someone_else", whenMade: "made_to_order", isSupply: true }],
    ["Production partners", { productionPartnerIds: [3, 4] }, { productionPartnerIds: [3, 4] }],
    ["Category", { taxonomyId: 500, taxonomyPath: "Clothing > Hoodies" }, { taxonomyId: 500 }],
    ["Shop section", { shopSectionId: 11, shopSectionTitle: "Sale" }, { shopSectionId: 11 }],
    ["Auto-renew", { autoRenew: false }, { shouldAutoRenew: false }],
    ["Feature this listing", { featureListing: true }, { featuredRank: 1 }],
    ["Price", { price: "25.00" }, { price: 25 }],
    ["Quantity", { quantity: "0" }, { quantity: 0 }],
    ["SKU", { sku: "TEE-2" }, { sku: "TEE-2" }],
    ["Processing profile", { readinessStateId: 8 }, { readinessStateId: 8 }],
  ])("%s", (_label, change, patch) => {
    expect(plan(PLAIN, change)).toEqual({ patch, unsynced: [] });
  });

  it("Attributes: a changed value, and a new attribute", () => {
    const changed = plan(PLAIN, {
      properties: {
        200: { ...PLAIN.properties[200], valueIds: [2], values: ["White"] },
        300: { name: "Occasion", valueIds: [9], values: ["Birthday"], scaleId: null },
      },
    });
    expect(changed.patch.attributes).toEqual([
      { propertyId: 200, valueIds: [2], values: ["White"] },
      { propertyId: 300, valueIds: [9], values: ["Birthday"] },
    ]);
  });

  it("Personalization: every question field is compared", () => {
    const question = {
      questionText: "Name",
      instructions: "Up to 10 letters",
      required: true,
      fieldType: "text_input" as const,
      maxAllowedCharacters: 10,
      maxAllowedFiles: 1,
      options: [],
    };
    const original = { ...PLAIN, personalizationQuestions: [question] };
    for (const change of [
      { questionText: "Initials" },
      { instructions: "Up to 3 letters" },
      { required: false },
      { maxAllowedCharacters: 3 },
      { fieldType: "dropdown" as const, options: ["Red", "Blue"] },
    ]) {
      expect(plan(original, { personalizationQuestions: [{ ...question, ...change }] }).patch).toEqual({
        personalization: [{ ...question, ...change }],
      });
    }
  });

  it("Variations: a per-combination price, a hidden combination and an option rename each send the whole grid", () => {
    const priced = plan(WITH_GRID, {
      variationToggles: { ...WITH_GRID.variationToggles, price: { enabled: true, appliesTo: [0] } },
      variationRows: { ...WITH_GRID.variationRows, price: { "11": "20.00", "12": "24.00" } },
    });
    expect(priced.patch.variations?.products.map((p) => p.price)).toEqual([20, 24]);
    expect(priced.patch.variations?.priceOnProperty).toEqual([100]);

    const hidden = plan(WITH_GRID, { variationRowEnabled: { "12": false } });
    expect(hidden.patch.variations?.products.map((p) => p.enabled)).toEqual([true, false]);

    const renamed = plan(WITH_GRID, { variations: [{ ...WITH_GRID.variations[0], values: ["Small", "M"] }] });
    expect(renamed.patch.variations?.products[0].propertyValues[0]).toMatchObject({ values: ["Small"], scaleId: 5 });
  });

  it("Variations: the scale is part of the grid Etsy stores", () => {
    const rescaled = plan(WITH_GRID, { variations: [{ ...WITH_GRID.variations[0], scaleId: 6 }] });
    expect(rescaled.patch.variations?.products[0].propertyValues[0].scaleId).toBe(6);
  });

  it("Variations: listing-wide price, quantity, SKU and processing on a variation listing go in the grid", () => {
    for (const change of [{ price: "30.00" }, { quantity: "9" }, { sku: "NEW" }, { readinessStateId: 8 }]) {
      const result = plan(WITH_GRID, change);
      expect(result.patch.variations).toBeDefined();
      expect(result.patch.price).toBeUndefined();
    }
  });

  it("Variation photos: a moved photo sends the listing's full set", () => {
    const moved = plan(WITH_GRID, { variationPhotos: { "11": "etsy:901" } });
    expect(moved.patch).toEqual({
      variationImages: [{ propertyId: 100, valueId: 11, value: "S", imageId: 901 }],
    });
  });
});

describe("editor sync — changes Etsy's API can't write are reported, never dropped", () => {
  it.each<[string, Partial<ListingFormValue>, string]>([
    ["un-featuring", { featureListing: true }, "Feature this listing"],
    ["Etsy Ads", { promoteWithAds: true }, "Promote with Etsy Ads"],
    ["removing the section", { shopSectionId: null, shopSectionTitle: "" }, "Shop section"],
    ["removing the category", { taxonomyId: null, taxonomyPath: "" }, "Category"],
    ["a blank price", { price: "" }, "Price"],
    ["a fractional quantity", { quantity: "1.5" }, "Quantity"],
    ["clearing the processing profile", { readinessStateId: null }, "Processing profile"],
    ["clearing an attribute", { properties: {} }, "Primary color"],
  ])("%s", (label, change, field) => {
    // Un-featuring starts from a featured listing.
    const original = label === "un-featuring" ? { ...PLAIN, featureListing: true } : PLAIN;
    const current = label === "un-featuring" ? { featureListing: false } : change;
    const result = plan(original, current);
    expect(result.unsynced.map((u) => u.field)).toEqual([field]);
    expect(result.unsynced[0].reason).not.toBe("");
  });

  it("a variation photo that isn't on Etsy yet is named, and the rest of the set still goes", () => {
    const result = plan(WITH_GRID, { variationPhotos: { "11": "etsy:900", "12": "own:abc" } });
    expect(result.patch.variationImages).toEqual([{ propertyId: 100, valueId: 11, value: "S", imageId: 900 }]);
    expect(result.unsynced.map((u) => u.field)).toEqual(["Variation photos"]);
  });

  it("removing the last variation is refused outright", () => {
    expect(editorSyncPatch(WITH_GRID, { ...WITH_GRID, variations: [] })).toEqual({
      error: "Variations: a listing's last variation can't be removed from here.",
    });
  });
});
