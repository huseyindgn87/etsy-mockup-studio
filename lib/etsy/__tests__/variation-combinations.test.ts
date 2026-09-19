import { describe, expect, test } from "vitest";
import {
  addColumnValue,
  buildCombinationModel,
  cellKeyFor,
  clearedVariationState,
  combinationDataLoss,
  createCombinationCache,
  describeDataLoss,
  moveColumnValue,
  removeColumn,
  removeColumnValue,
  renameColumnValue,
  setColumnProperty,
  type VariationDimension,
  type VariationState,
} from "@/lib/etsy/variation-combinations";

function dimension(propertyId: number, name: string, values: string[], ids?: number[]): VariationDimension {
  return {
    propertyId,
    name,
    isCustom: false,
    valueIds: ids ?? values.map((_, i) => propertyId * 1000 + i + 1),
    values,
    linksPhotos: false,
  };
}

function state(variations: VariationDimension[], patch: Partial<VariationState> = {}): VariationState {
  return { ...clearedVariationState(), variations, ...patch };
}

const size = () => dimension(100, "Size", ["S", "M", "L"], [11, 12, 13]);
const color = () => dimension(200, "Color", ["Black", "White"], [21, 22]);

describe("combination model", () => {
  test("is the cross product in column order, keyed by every value id", () => {
    const model = buildCombinationModel([size(), color()]);
    expect(model.count).toBe(6);
    expect(model.combinations.map((c) => c.key)).toEqual(["11:21", "11:22", "12:21", "12:22", "13:21", "13:22"]);
    expect(model.combinations.map((c) => c.values.join(" / "))).toEqual([
      "S / Black",
      "S / White",
      "M / Black",
      "M / White",
      "L / Black",
      "L / White",
    ]);
    expect(model.byKey.get("12:22")?.values).toEqual(["M", "White"]);
  });

  test("follows value order and a third variation", () => {
    const material = dimension(300, "Material", ["Cotton", "Linen"], [31, 32]);
    const reordered = { ...color(), valueIds: [22, 21], values: ["White", "Black"] };
    const model = buildCombinationModel([size(), reordered, material]);
    expect(model.count).toBe(12);
    expect(model.combinations.slice(0, 4).map((c) => c.key)).toEqual(["11:22:31", "11:22:32", "11:21:31", "11:21:32"]);
    expect(new Set(model.combinations.map((c) => c.key)).size).toBe(12);
  });

  test("handles 18 × 25 = 450 rows", () => {
    const sizes = dimension(1, "Size", Array.from({ length: 18 }, (_, i) => `S${i}`));
    const colors = dimension(2, "Color", Array.from({ length: 25 }, (_, i) => `C${i}`));
    const model = buildCombinationModel([sizes, colors]);
    expect(model.count).toBe(450);
    expect(model.combinations).toHaveLength(450);
    expect(model.byKey.size).toBe(450);
    expect(model.combinations[449].values).toEqual(["S17", "C24"]);
  });

  test("has no combinations with no variations or with a column that has no values yet", () => {
    expect(buildCombinationModel([]).count).toBe(0);
    const model = buildCombinationModel([size(), dimension(200, "Color", [])]);
    expect(model.count).toBe(0);
    expect(model.combinations).toEqual([]);
  });

  test("counts but doesn't list a grid past Etsy's loosest limit", () => {
    const big = (id: number) => dimension(id, `P${id}`, Array.from({ length: 70 }, (_, i) => `v${i}`));
    const model = buildCombinationModel([big(1), big(2), big(3)]);
    expect(model.count).toBe(343000);
    expect(model.tooMany).toBe(true);
    expect(model.combinations).toEqual([]);
  });

  test("the cache reuses the model until ids, names or order change", () => {
    const combinationsFor = createCombinationCache();
    const variations = [size(), color()];
    const first = combinationsFor(variations);
    expect(combinationsFor(variations)).toBe(first);
    expect(combinationsFor([size(), color()])).toBe(first);

    const renamed = combinationsFor([size(), { ...color(), values: ["Black", "Ivory"] }]);
    expect(renamed).not.toBe(first);
    expect(renamed.combinations[1].values).toEqual(["S", "Ivory"]);

    const moved = combinationsFor(moveColumnValue(state([size(), color()]), 0, 0, 2).variations);
    expect(moved.combinations[0].key).toBe("12:21");
  });
});

describe("column edits", () => {
  test("choosing a property appends an empty column, or replaces one", () => {
    let s = setColumnProperty(state([]), 0, { propertyId: 100, name: "Size", isCustom: false, scaleId: 5 });
    expect(s.variations).toEqual([
      { propertyId: 100, name: "Size", isCustom: false, valueIds: [], values: [], linksPhotos: false, scaleId: 5 },
    ]);
    s = setColumnProperty(s, 1, { propertyId: 200, name: "Color", isCustom: false });
    expect(s.variations.map((v) => v.name)).toEqual(["Size", "Color"]);
    expect(setColumnProperty(s, 3, { propertyId: 300, name: "Material", isCustom: false })).toBe(s);

    s = addColumnValue(s, 0, { name: "S", valueId: 11 });
    expect(setColumnProperty(s, 0, { propertyId: 100, name: "Size", isCustom: false })).toBe(s);
    const replaced = setColumnProperty(s, 0, { propertyId: 300, name: "Material", isCustom: false });
    expect(replaced.variations[0]).toMatchObject({ propertyId: 300, valueIds: [], values: [] });
  });

  test("adds values with Etsy's id, or a free-text id per column kind, ignoring blanks and duplicates", () => {
    let s = state([dimension(100, "Size", [], [])]);
    s = addColumnValue(s, 0, { name: " S ", valueId: 11 });
    s = addColumnValue(s, 0, { name: "Tall" });
    s = addColumnValue(s, 0, { name: "Petite" });
    expect(s.variations[0].valueIds).toEqual([11, -1, -2]);
    expect(s.variations[0].values).toEqual(["S", "Tall", "Petite"]);
    expect(addColumnValue(s, 0, { name: "tall" })).toBe(s);
    expect(addColumnValue(s, 0, { name: "   " })).toBe(s);
    expect(addColumnValue(s, 0, { name: "Small", valueId: 11 })).toBe(s);

    let custom = state([{ ...dimension(513, "Paper", [], []), isCustom: true }]);
    custom = addColumnValue(custom, 0, { name: "Matte" });
    custom = addColumnValue(custom, 0, { name: "Gloss" });
    expect(custom.variations[0].valueIds).toEqual([1, 2]);
  });

  test("refuses a 71st value", () => {
    const full = state([dimension(1, "Size", Array.from({ length: 70 }, (_, i) => `v${i}`))]);
    expect(addColumnValue(full, 0, { name: "one more" })).toBe(full);
  });

  test("removes a value and reorders within a column", () => {
    let s = state([size(), color()]);
    s = removeColumnValue(s, 0, 1);
    expect(s.variations[0].values).toEqual(["S", "L"]);
    expect(s.variations[0].valueIds).toEqual([11, 13]);

    s = moveColumnValue(s, 1, 1, 0);
    expect(s.variations[1].values).toEqual(["White", "Black"]);
    expect(s.variations[1].valueIds).toEqual([22, 21]);
    expect(s.variations[0].values).toEqual(["S", "L"]);
    expect(moveColumnValue(s, 1, 0, 5)).toBe(s);
  });

  test("removing a column shifts later columns and what fields vary by", () => {
    const s = state([size(), color()], {
      variationToggles: {
        ...clearedVariationState().variationToggles,
        price: { enabled: true, appliesTo: [1] },
        sku: { enabled: true, appliesTo: [0] },
      },
      variationRows: { ...clearedVariationState().variationRows, price: { "21": "10", "22": "12" }, sku: { "11": "A" } },
    });
    const next = removeColumn(s, 0);
    expect(next.variations.map((v) => v.name)).toEqual(["Color"]);
    expect(next.variationToggles.price).toEqual({ enabled: true, appliesTo: [0] });
    expect(next.variationRows.price).toEqual({ "21": "10", "22": "12" });
    expect(next.variationToggles.sku).toEqual({ enabled: false, appliesTo: [] });
    expect(next.variationRows.sku).toEqual({});
  });
});

describe("destructive-change detection", () => {
  /** Size × Color with price varying by size and SKU by both. */
  function priced(): VariationState {
    const ids = buildCombinationModel([size(), color()]).combinations;
    return state([size(), color()], {
      variationToggles: {
        ...clearedVariationState().variationToggles,
        price: { enabled: true, appliesTo: [0] },
        sku: { enabled: true, appliesTo: [0, 1] },
      },
      variationRows: {
        ...clearedVariationState().variationRows,
        price: { "11": "20", "12": "22", "13": "" },
        sku: Object.fromEntries(ids.filter((c) => c.valueIds[0] !== 13).map((c) => [cellKeyFor([0, 1], c.valueIds), c.key])),
      },
      variationRowEnabled: { "11:22": false },
    });
  }

  test("reports combinations whose price or SKU a value removal deletes", () => {
    const before = priced();
    const loss = combinationDataLoss(before, removeColumnValue(before, 0, 0));
    expect(loss.combinations).toBe(2);
    expect(loss.fields).toEqual([
      { field: "price", combinations: 2 },
      { field: "sku", combinations: 2 },
    ]);
    expect(describeDataLoss(loss)).toBe("2 combinations with price or SKU data");

    const colorLoss = combinationDataLoss(before, removeColumnValue(before, 1, 1));
    expect(colorLoss).toEqual({ combinations: 2, fields: [{ field: "sku", combinations: 2 }] });
    expect(describeDataLoss(colorLoss)).toBe("2 combinations with SKU data");
  });

  test("says nothing when the removed value has no data", () => {
    const before = priced();
    expect(combinationDataLoss(before, removeColumnValue(before, 0, 2)).combinations).toBe(0);
  });

  test("never warns for reordering, adding values or picking a property for a new column", () => {
    const before = priced();
    expect(combinationDataLoss(before, moveColumnValue(before, 0, 0, 2)).combinations).toBe(0);
    expect(combinationDataLoss(before, addColumnValue(before, 1, { name: "Red" })).combinations).toBe(0);
    const withPriceOnly = { ...before, variationToggles: { ...before.variationToggles, sku: { enabled: false, appliesTo: [] } } };
    const oneColumn = removeColumn(withPriceOnly, 1);
    const added = setColumnProperty(oneColumn, 1, { propertyId: 300, name: "Material", isCustom: false });
    expect(combinationDataLoss(oneColumn, added).combinations).toBe(0);
    expect(added.variationRows.price).toEqual({ "11": "20", "12": "22", "13": "" });
  });

  test("warns when a column holding data is removed or replaced, or the category changes", () => {
    const before = priced();
    expect(combinationDataLoss(before, removeColumn(before, 1))).toEqual({
      combinations: 4,
      fields: [{ field: "sku", combinations: 4 }],
    });
    expect(combinationDataLoss(before, removeColumn(before, 0)).combinations).toBe(4);
    const replaced = setColumnProperty(before, 0, { propertyId: 300, name: "Material", isCustom: false });
    expect(combinationDataLoss(before, replaced).combinations).toBe(4);
    expect(combinationDataLoss(before, clearedVariationState()).combinations).toBe(4);
  });

  test("a confirmed removal also drops the orphaned cells and visibility flags", () => {
    const next = removeColumnValue(priced(), 0, 0);
    expect(next.variationRows.price).toEqual({ "12": "22", "13": "" });
    expect(Object.keys(next.variationRows.sku)).toEqual(["12:21", "12:22"]);
    expect(next.variationRowEnabled).toEqual({});
  });
});

describe("renameColumnValue", () => {
  const priced = () =>
    state([size(), color()], {
      variationToggles: {
        ...clearedVariationState().variationToggles,
        price: { enabled: true, appliesTo: [1] },
        quantity: { enabled: true, appliesTo: [0, 1] },
      },
      variationRows: {
        ...clearedVariationState().variationRows,
        price: { "21": "20.00", "22": "25.00" },
        quantity: { "11:21": "3", "12:21": "4" },
      },
      variationRowEnabled: { "11:21": false },
    });

  test("changes only the name; every cell of that value moves to its new id", () => {
    const result = renameColumnValue(priced(), 1, 0, "Jet Black")!;
    expect(result.oldId).toBe(21);
    expect(result.newId).toBe(-1);
    expect(result.state.variations[1].values).toEqual(["Jet Black", "White"]);
    expect(result.state.variations[1].valueIds).toEqual([-1, 22]);
    expect(result.state.variationRows.price).toEqual({ "-1": "20.00", "22": "25.00" });
    expect(result.state.variationRows.quantity).toEqual({ "11:-1": "3", "12:-1": "4" });
    expect(result.state.variationRowEnabled).toEqual({ "11:-1": false });
    expect(result.state.variations[0]).toEqual(size());
  });

  test("a matching id in another column is left alone", () => {
    const s = state([size(), dimension(200, "Color", ["Black"], [11])], {
      variationToggles: { ...clearedVariationState().variationToggles, sku: { enabled: true, appliesTo: [0, 1] } },
      variationRows: { ...clearedVariationState().variationRows, sku: { "11:11": "SKU-1" } },
    });
    expect(renameColumnValue(s, 1, 0, "Onyx")!.state.variationRows.sku).toEqual({ "11:-1": "SKU-1" });
  });

  test("a custom variation's renamed value gets the next positive id", () => {
    const custom = { ...size(), isCustom: true };
    expect(renameColumnValue(state([custom]), 0, 1, "Medium")!.newId).toBe(14);
  });

  test("blank, unchanged and duplicate names are ignored", () => {
    expect(renameColumnValue(priced(), 0, 0, "  ")).toBeNull();
    expect(renameColumnValue(priced(), 0, 0, "S")).toBeNull();
    expect(renameColumnValue(priced(), 0, 0, "m")).toBeNull();
  });
});
