import { describe, expect, it } from "vitest";
import {
  applyNumericToForm,
  applyNumericToValue,
  applyProcessingToForm,
  applySkuText,
  applySkuToForm,
  isUsableNumeric,
} from "@/lib/etsy/bulk-operations";
import type { VariationGrid } from "@/lib/etsy/variation-grid";
import {
  gridToOfferingState,
  offeringStateToBulkVariations,
  offeringStateToVariationImages,
} from "@/lib/etsy/variation-grid-form";

const combo = (
  valueIds: (number | null)[],
  values: string[],
  over: Partial<VariationGrid["combinations"][number]> = {},
): VariationGrid["combinations"][number] => ({
  key: valueIds.map((id, i) => (id == null ? `t:${values[i]}` : String(id))).join(":"),
  valueIds,
  values,
  price: 20,
  quantity: 4,
  sku: "TEE",
  enabled: true,
  readinessStateId: 7,
  ...over,
});

/** Size (S, custom "XXL") × Color (Black, White); price by size, SKU by both. */
const GRID: VariationGrid = {
  listingId: 1,
  properties: [
    { propertyId: 100, name: "Size", scaleId: 5, options: [{ valueId: 11, name: "S" }, { valueId: null, name: "XXL" }] },
    { propertyId: 200, name: "Color", scaleId: null, options: [{ valueId: 21, name: "Black" }, { valueId: 22, name: "White" }] },
  ],
  combinations: [
    combo([11, 21], ["S", "Black"], { sku: "S-B" }),
    combo([11, 22], ["S", "White"], { sku: "S-W" }),
    combo([null, 21], ["XXL", "Black"], { price: 24, sku: "X-B" }),
    combo([null, 22], ["XXL", "White"], { price: 24, sku: "X-W", enabled: false }),
  ],
  priceOnProperty: [100],
  quantityOnProperty: [],
  skuOnProperty: [100, 200],
  readinessStateOnProperty: [],
};

const DEFAULTS = { price: 20, quantity: 4, sku: "", readinessStateId: 7 };

describe("inventory grid → variation form", () => {
  const state = gridToOfferingState(GRID, DEFAULTS);

  it("keeps Etsy's value ids and gives free-text options negative ones", () => {
    expect(state.variations.map((v) => [v.propertyId, v.valueIds, v.values, v.scaleId])).toEqual([
      [100, [11, -1], ["S", "XXL"], 5],
      [200, [21, 22], ["Black", "White"], null],
    ]);
  });

  it("turns *_on_property into Individual toggles with one cell per value", () => {
    expect(state.variationToggles.price).toEqual({ enabled: true, appliesTo: [0] });
    expect(state.variationToggles.quantity).toEqual({ enabled: false, appliesTo: [] });
    expect(state.variationRows.price).toEqual({ "11": "20.00", "-1": "24.00" });
    expect(state.variationRows.sku).toEqual({ "11:21": "S-B", "11:22": "S-W", "-1:21": "X-B", "-1:22": "X-W" });
    expect(state.quantity).toBe("4");
    expect(state.readinessStateId).toBe(7);
    expect(state.variationRowEnabled).toEqual({ "-1:22": false });
  });

  it("round-trips to the same products Etsy has", () => {
    const back = offeringStateToBulkVariations(state)!;
    expect(back.priceOnProperty).toEqual([100]);
    expect(back.skuOnProperty).toEqual([100, 200]);
    expect(back.products).toEqual([
      { propertyValues: [{ propertyId: 100, name: "Size", scaleId: 5, valueIds: [11], values: ["S"] }, { propertyId: 200, name: "Color", valueIds: [21], values: ["Black"] }], price: 20, quantity: 4, sku: "S-B", readinessStateId: 7, enabled: true },
      { propertyValues: [{ propertyId: 100, name: "Size", scaleId: 5, valueIds: [11], values: ["S"] }, { propertyId: 200, name: "Color", valueIds: [22], values: ["White"] }], price: 20, quantity: 4, sku: "S-W", readinessStateId: 7, enabled: true },
      { propertyValues: [{ propertyId: 100, name: "Size", scaleId: 5, valueIds: [null], values: ["XXL"] }, { propertyId: 200, name: "Color", valueIds: [21], values: ["Black"] }], price: 24, quantity: 4, sku: "X-B", readinessStateId: 7, enabled: true },
      { propertyValues: [{ propertyId: 100, name: "Size", scaleId: 5, valueIds: [null], values: ["XXL"] }, { propertyId: 200, name: "Color", valueIds: [22], values: ["White"] }], price: 24, quantity: 4, sku: "X-W", readinessStateId: 7, enabled: false },
    ]);
  });

  it("a listing without variations has an empty form and no grid to write", () => {
    const plain = gridToOfferingState({ ...GRID, properties: [], combinations: [combo([], [])], priceOnProperty: [], skuOnProperty: [] }, { ...DEFAULTS, sku: "MUG" });
    expect(plain).toMatchObject({ variations: [], price: "20.00", quantity: "4", sku: "MUG" });
    expect(offeringStateToBulkVariations(plain)).toBeNull();
  });
});

describe("bulk bar operations", () => {
  const state = gridToOfferingState(GRID, DEFAULTS);

  it("price and quantity operations on a single value, by amount or percentage", () => {
    expect(applyNumericToValue("price", "10.00", { operation: "set", amount: "12.5", unit: "amount" })).toBe("12.50");
    expect(applyNumericToValue("price", "10.00", { operation: "increase", amount: "15", unit: "percent" })).toBe("11.50");
    expect(applyNumericToValue("quantity", "3", { operation: "decrease", amount: "2", unit: "amount" })).toBe("1");
    expect(applyNumericToValue("quantity", "3", { operation: "decrease", amount: "5", unit: "amount" })).toBeNull();
    expect(applyNumericToValue("price", "", { operation: "increase", amount: "1", unit: "amount" })).toBeNull();
  });

  it("Apply is usable only with a valid amount, and never a percentage for Set to or quantity", () => {
    expect(isUsableNumeric("price", { operation: "set", amount: "", unit: "amount" })).toBe(false);
    expect(isUsableNumeric("price", { operation: "set", amount: "10", unit: "percent" })).toBe(false);
    expect(isUsableNumeric("quantity", { operation: "increase", amount: "10", unit: "percent" })).toBe(false);
    expect(isUsableNumeric("quantity", { operation: "increase", amount: "1.5", unit: "amount" })).toBe(false);
    expect(isUsableNumeric("price", { operation: "decrease", amount: "2.25", unit: "amount" })).toBe(true);
  });

  it("an operation on a variation form reaches every row, or the listing-wide value", () => {
    expect(applyNumericToForm(state, "price", { operation: "increase", amount: "10", unit: "percent" })).toEqual({
      variationRows: { ...state.variationRows, price: { "11": "22.00", "-1": "26.40" } },
    });
    expect(applyNumericToForm(state, "quantity", { operation: "set", amount: "9", unit: "amount" })).toEqual({ quantity: "9" });
    expect(applyNumericToForm(state, "price", { operation: "decrease", amount: "21", unit: "amount" })).toBeNull();
  });

  it("SKU text goes before, after, or replaces — on every SKU a grid holds", () => {
    expect(applySkuText("MUG", "before", "GH-")).toBe("GH-MUG");
    expect(applySkuText("MUG", "after", "-2")).toBe("MUG-2");
    expect(applySkuText("MUG", "replace", "NEW")).toBe("NEW");
    expect(applySkuToForm(state, "before", "GH-").variationRows!.sku).toEqual({
      "11:21": "GH-S-B",
      "11:22": "GH-S-W",
      "-1:21": "GH-X-B",
      "-1:22": "GH-X-W",
    });
  });

  it("a processing profile is set listing-wide and on any per-row cells", () => {
    expect(applyProcessingToForm(state, 9)).toEqual({ readinessStateId: 9 });
    const byColor = { ...state, variationToggles: { ...state.variationToggles, readiness: { enabled: true, appliesTo: [1] } } };
    expect(applyProcessingToForm(byColor, 9)).toMatchObject({
      readinessStateId: 9,
      variationRows: { readiness: { "21": "9", "22": "9" } },
    });
  });
});

describe("variation photos ↔ the form", () => {
  const images = [
    { propertyId: 100, valueId: 11, value: "S", imageId: 900 },
    { propertyId: 100, valueId: 555, value: "XXL", imageId: 901 },
  ];

  it("marks the photo variation and maps Etsy's photos onto the grid's tiles, free-text values by name", () => {
    const state = gridToOfferingState(GRID, DEFAULTS, images);
    expect(state.variations.map((v) => v.linksPhotos)).toEqual([true, false]);
    expect(state.variationPhotos).toEqual({ "11": "etsy:900", "-1": "etsy:901" });
  });

  it("turns back into the full set, with free-text values sent by name and no id", () => {
    expect(offeringStateToVariationImages(gridToOfferingState(GRID, DEFAULTS, images))).toEqual([
      { propertyId: 100, valueId: 11, value: "S", imageId: 900 },
      { propertyId: 100, valueId: null, value: "XXL", imageId: 901 },
    ]);
  });

  it("a cleared value leaves the set; clearing all gives an empty set", () => {
    const state = gridToOfferingState(GRID, DEFAULTS, images);
    expect(offeringStateToVariationImages({ ...state, variationPhotos: { "11": "etsy:900" } })).toEqual([
      { propertyId: 100, valueId: 11, value: "S", imageId: 900 },
    ]);
    expect(offeringStateToVariationImages({ ...state, variationPhotos: {} })).toEqual([]);
  });

  it("only photos already on the listing can be sent", () => {
    const state = gridToOfferingState(GRID, DEFAULTS, images);
    expect(offeringStateToVariationImages({ ...state, variationPhotos: { "11": "own:abc" } })).toEqual([]);
  });
});
