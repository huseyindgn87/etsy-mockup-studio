import { describe, expect, test } from "vitest";
import {
  addOption,
  combinationKey,
  removeOption,
  renameOption,
  reorderOption,
  toVariationPatch,
  updateCombination,
  type VariationGrid,
} from "@/lib/etsy/variation-grid";

/** A colour × size grid: the shape the Variations card edits. */
function grid(): VariationGrid {
  const colours = [
    { valueId: 1, name: "Red" },
    { valueId: 2, name: "Blue" },
  ];
  const sizes = [{ valueId: 10, name: "S" }, { valueId: 11, name: "M" }];
  const combinations = [];
  for (const colour of colours) {
    for (const size of sizes) {
      combinations.push({
        key: combinationKey([colour.valueId, size.valueId], [colour.name, size.name]),
        valueIds: [colour.valueId, size.valueId] as (number | null)[],
        values: [colour.name, size.name],
        price: colour.name === "Red" ? 10 : 12,
        quantity: 3,
        sku: `${colour.name}-${size.name}`,
        enabled: true,
        readinessStateId: null,
      });
    }
  }
  return {
    listingId: 101,
    properties: [
      { propertyId: 200, name: "Color", scaleId: null, options: colours },
      { propertyId: 100, name: "Size", scaleId: null, options: sizes },
    ],
    combinations,
    priceOnProperty: [200],
    quantityOnProperty: [],
    skuOnProperty: [],
    readinessStateOnProperty: [],
  };
}

const names = (g: VariationGrid, propertyId: number) =>
  g.properties.find((p) => p.propertyId === propertyId)!.options.map((o) => o.name);
const rows = (g: VariationGrid) => g.combinations.map((c) => c.values.join("/"));

describe("reordering options", () => {
  test("moves the option and re-orders the combinations to match", () => {
    const next = reorderOption(grid(), 200, 0, 1);
    expect(names(next, 200)).toEqual(["Blue", "Red"]);
    expect(rows(next)).toEqual(["Blue/S", "Blue/M", "Red/S", "Red/M"]);
  });

  test("every combination keeps its own price, quantity and SKU", () => {
    const next = reorderOption(grid(), 200, 0, 1);
    const redSmall = next.combinations.find((c) => c.values.join("/") === "Red/S")!;
    expect(redSmall).toMatchObject({ price: 10, quantity: 3, sku: "Red-S" });
  });

  test("an out-of-range move changes nothing", () => {
    expect(rows(reorderOption(grid(), 200, 0, 9))).toEqual(rows(grid()));
  });
});

describe("adding an option", () => {
  test("adds the combinations the new option makes possible", () => {
    const next = addOption(grid(), 200, "Green");
    expect(names(next, 200)).toEqual(["Red", "Blue", "Green"]);
    expect(rows(next)).toEqual(["Red/S", "Red/M", "Blue/S", "Blue/M", "Green/S", "Green/M"]);
  });

  test("existing combinations keep their values; new ones inherit the first row's terms", () => {
    const next = addOption(grid(), 200, "Green");
    expect(next.combinations.find((c) => c.values.join("/") === "Blue/M")).toMatchObject({
      price: 12,
      sku: "Blue-M",
    });
    expect(next.combinations.find((c) => c.values.join("/") === "Green/S")).toMatchObject({
      price: 10,
      quantity: 3,
      sku: "",
      enabled: true,
    });
  });

  test("a value the seller types goes as free text, with no invented Etsy id", () => {
    const next = addOption(grid(), 200, "Green");
    const added = next.properties.find((p) => p.propertyId === 200)!.options.at(-1)!;
    expect(added).toEqual({ valueId: null, name: "Green" });
  });

  test("a blank or duplicate option is ignored", () => {
    expect(rows(addOption(grid(), 200, "   "))).toEqual(rows(grid()));
    expect(rows(addOption(grid(), 200, "red"))).toEqual(rows(grid()));
  });
});

describe("removing an option", () => {
  test("drops exactly the combinations that used it", () => {
    const next = removeOption(grid(), 200, { valueId: 1, name: "Red" });
    expect(names(next, 200)).toEqual(["Blue"]);
    expect(rows(next)).toEqual(["Blue/S", "Blue/M"]);
  });

  test("refuses to remove a property's last option rather than rewrite the listing's structure", () => {
    const oneLeft = removeOption(grid(), 200, { valueId: 1, name: "Red" });
    const unchanged = removeOption(oneLeft, 200, { valueId: 2, name: "Blue" });
    expect(names(unchanged, 200)).toEqual(["Blue"]);
    expect(rows(unchanged)).toEqual(["Blue/S", "Blue/M"]);
  });
});

describe("renaming an option", () => {
  test("keeps the option's position and its rows' own values", () => {
    const next = renameOption(grid(), 200, { valueId: 1, name: "Red" }, "Crimson");
    expect(names(next, 200)).toEqual(["Crimson", "Blue"]);
    expect(next.combinations.find((c) => c.values.join("/") === "Crimson/S")).toMatchObject({
      price: 10,
      sku: "Red-S",
    });
  });

  test("a blank name is ignored", () => {
    expect(names(renameOption(grid(), 200, { valueId: 1, name: "Red" }, "  "), 200)).toEqual([
      "Red",
      "Blue",
    ]);
  });
});

describe("editing one combination", () => {
  test("changes only that row", () => {
    const target = grid().combinations[0].key;
    const next = updateCombination(grid(), target, { price: 99, enabled: false });
    expect(next.combinations[0]).toMatchObject({ price: 99, enabled: false });
    expect(next.combinations[1]).toMatchObject({ price: 10, enabled: true });
  });
});

describe("the patch sent to Etsy", () => {
  test("carries every combination, each with its own property values", () => {
    const patch = toVariationPatch(grid());
    expect(patch.products).toHaveLength(4);
    expect(patch.products[0].propertyValues).toEqual([
      { propertyId: 200, name: "Color", valueIds: [1], values: ["Red"] },
      { propertyId: 100, name: "Size", valueIds: [10], values: ["S"] },
    ]);
    expect(patch.priceOnProperty).toEqual([200]);
  });

  test("a disabled combination is sent as disabled, never dropped", () => {
    const key = grid().combinations[0].key;
    const patch = toVariationPatch(updateCombination(grid(), key, { enabled: false }));
    expect(patch.products).toHaveLength(4);
    expect(patch.products[0].enabled).toBe(false);
  });

  test("a row with no price of its own leaves it to the listing's value", () => {
    const key = grid().combinations[0].key;
    const patch = toVariationPatch(updateCombination(grid(), key, { price: null }));
    expect(patch.products[0].price).toBeUndefined();
  });
});
