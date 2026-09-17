import { describe, expect, test } from "vitest";
import type { TaxonomyNode } from "@/lib/etsy/taxonomy";
import {
  cascadeLevels,
  indexTaxonomy,
  selectCascadeLevel,
  taxonomyChain,
} from "@/lib/etsy/taxonomy-cascade";

function node(id: number, name: string, parentId: number | null, children: TaxonomyNode[] = [], level = 1): TaxonomyNode {
  return { id, level, name, parentId, children };
}

const TREE: TaxonomyNode[] = [
  node(1, "Clothing", null, [
    node(2, "Gender-Neutral Adult Clothing", 1, [
      node(3, "Tops & Tees", 2, [node(482, "T-shirts", 3), node(483, "Tank Tops", 3)]),
      node(4, "Hoodies & Sweatshirts", 2, [node(490, "Hoodies", 4)]),
    ]),
  ]),
  node(10, "Home & Living", null, [node(11, "Wall Decor", 10)]),
  node(20, "Deep", null, [node(21, "A", 20, [node(22, "B", 21, [node(23, "C", 22, [node(24, "D", 23)])])])]),
];
const INDEX = indexTaxonomy(TREE);

describe("taxonomy cascade", () => {
  test("nothing chosen: only Category is enabled", () => {
    const levels = cascadeLevels(TREE, INDEX, null);
    expect(levels.map((l) => l.label)).toEqual(["Category", "Sub-category", "Group", "Item type"]);
    expect(levels.map((l) => l.disabled)).toEqual([false, true, true, true]);
    expect(levels[0].options.map((o) => o.name)).toEqual(["Clothing", "Home & Living", "Deep"]);
    expect(levels.map((l) => l.selectedId)).toEqual([null, null, null, null]);
  });

  test("each level opens once the one above is chosen, listing that node's children", () => {
    const levels = cascadeLevels(TREE, INDEX, 2);
    expect(levels.map((l) => l.selectedId)).toEqual([1, 2, null, null]);
    expect(levels.map((l) => l.disabled)).toEqual([false, false, false, true]);
    expect(levels[2].options.map((o) => o.name)).toEqual(["Tops & Tees", "Hoodies & Sweatshirts"]);

    const leaf = cascadeLevels(TREE, INDEX, 482);
    expect(leaf.map((l) => l.selectedId)).toEqual([1, 2, 3, 482]);
    expect(leaf[3].options.map((o) => o.name)).toEqual(["T-shirts", "Tank Tops"]);
  });

  test("a shallow branch leaves the lower levels disabled", () => {
    const levels = cascadeLevels(TREE, INDEX, 11);
    expect(levels.map((l) => l.selectedId)).toEqual([10, 11, null, null]);
    expect(levels.map((l) => l.disabled)).toEqual([false, false, true, true]);
  });

  test("a deeper branch gets one more dropdown per level", () => {
    expect(cascadeLevels(TREE, INDEX, 23)).toHaveLength(5);
    expect(cascadeLevels(TREE, INDEX, 24).map((l) => l.selectedId)).toEqual([20, 21, 22, 23, 24]);
  });

  test("changing a level clears every level below it", () => {
    expect(selectCascadeLevel(INDEX, 482, 0, 10)).toEqual({ taxonomyId: 10, taxonomyPath: "Home & Living" });
    expect(selectCascadeLevel(INDEX, 482, 2, 4)).toEqual({
      taxonomyId: 4,
      taxonomyPath: "Clothing > Gender-Neutral Adult Clothing > Hoodies & Sweatshirts",
    });
    expect(selectCascadeLevel(INDEX, 482, 3, 483).taxonomyPath).toBe(
      "Clothing > Gender-Neutral Adult Clothing > Tops & Tees > Tank Tops",
    );
  });

  test("clearing a level falls back to the level above", () => {
    expect(selectCascadeLevel(INDEX, 482, 2, null)).toEqual({
      taxonomyId: 2,
      taxonomyPath: "Clothing > Gender-Neutral Adult Clothing",
    });
    expect(selectCascadeLevel(INDEX, 482, 0, null)).toEqual({ taxonomyId: null, taxonomyPath: "" });
  });

  test("an id missing from the tree has no chain", () => {
    expect(taxonomyChain(INDEX, 999)).toEqual([]);
    expect(cascadeLevels(TREE, INDEX, 999).map((l) => l.selectedId)).toEqual([null, null, null, null]);
  });
});
