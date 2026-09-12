import { beforeEach, describe, expect, test, vi } from "vitest";

const etsyFetch = vi.fn<(path: string) => Promise<Response>>();
vi.mock("@/lib/etsy/auth", () => ({ etsyFetch: (path: string) => etsyFetch(path) }));

import {
  getSellerTaxonomyTree,
  getShopSectionsList,
  getTaxonomyProperties,
} from "@/lib/etsy/taxonomy";

const json = (body: unknown, ok = true, status = 200): Response =>
  ({ ok, status, json: async () => body, text: async () => JSON.stringify(body) }) as Response;

beforeEach(() => {
  etsyFetch.mockReset();
});

describe("getSellerTaxonomyTree", () => {
  test("maps the nested tree (snake_case -> camelCase) and caches it", async () => {
    etsyFetch.mockResolvedValue(
      json({
        results: [
          {
            id: 1,
            level: 0,
            name: "Clothing",
            parent_id: null,
            children: [{ id: 2, level: 1, name: "Shoes", parent_id: 1, children: [] }],
          },
        ],
      }),
    );

    const tree = await getSellerTaxonomyTree();
    expect(tree).toEqual([
      {
        id: 1,
        level: 0,
        name: "Clothing",
        parentId: null,
        children: [{ id: 2, level: 1, name: "Shoes", parentId: 1, children: [] }],
      },
    ]);

    await getSellerTaxonomyTree();
    expect(etsyFetch).toHaveBeenCalledTimes(1); // second call served from cache
  });
});

describe("getTaxonomyProperties", () => {
  test("keeps properties with selectable values (attribute and/or variation), flags each, maps fields, and caches per id", async () => {
    etsyFetch.mockResolvedValue(
      json({
        results: [
          {
            property_id: 200,
            name: "primary_color",
            display_name: "Primary color",
            is_required: false,
            supports_attributes: true,
            supports_variations: true,
            is_multivalued: true,
            max_values_allowed: 2,
            possible_values: [
              { value_id: 1, name: "Black" },
              { value_id: 2, name: "Red" },
            ],
          },
          // variations-only (no supports_attributes) -> still kept, just flagged differently.
          // Also has scales (US/UK) — each possible value tags which one it belongs to.
          {
            property_id: 300,
            name: "size",
            display_name: "Size",
            supports_attributes: false,
            supports_variations: true,
            scales: [
              { scale_id: 1, display_name: "US" },
              { scale_id: 2, display_name: "UK" },
            ],
            possible_values: [
              { value_id: 9, name: "9", scale_id: 1 },
              { value_id: 42, name: "8.5", scale_id: 2 },
            ],
          },
          // no possible_values -> excluded (nothing to select)
          {
            property_id: 400,
            name: "custom_message",
            display_name: "Custom message",
            supports_attributes: true,
            possible_values: [],
          },
        ],
      }),
    );

    const props = await getTaxonomyProperties(1429);
    expect(props).toEqual([
      {
        propertyId: 200,
        name: "primary_color",
        displayName: "Primary color",
        isRequired: false,
        isMultivalued: true,
        maxValuesAllowed: 2,
        supportsAttributes: true,
        supportsVariations: true,
        scales: [],
        possibleValues: [
          { valueId: 1, name: "Black", scaleId: null },
          { valueId: 2, name: "Red", scaleId: null },
        ],
      },
      {
        propertyId: 300,
        name: "size",
        displayName: "Size",
        isRequired: false,
        isMultivalued: false,
        maxValuesAllowed: null,
        supportsAttributes: false,
        supportsVariations: true,
        scales: [
          { scaleId: 1, displayName: "US" },
          { scaleId: 2, displayName: "UK" },
        ],
        possibleValues: [
          { valueId: 9, name: "9", scaleId: 1 },
          { valueId: 42, name: "8.5", scaleId: 2 },
        ],
      },
    ]);

    await getTaxonomyProperties(1429);
    expect(etsyFetch).toHaveBeenCalledTimes(1);

    await getTaxonomyProperties(9999);
    expect(etsyFetch).toHaveBeenCalledTimes(2); // a different category isn't cached together
  });
});

describe("getShopSectionsList", () => {
  test("sorts by rank, maps fields, and caches per shop (but not the shop id lookup)", async () => {
    let sectionCalls = 0;
    let meCalls = 0;
    etsyFetch.mockImplementation(async (path: string) => {
      if (path.includes("/users/me")) {
        meCalls++;
        return json({ user_id: 1, shop_id: 42 });
      }
      if (path.includes("/shops/42/sections")) {
        sectionCalls++;
        return json({
          results: [
            { shop_section_id: 2, title: "B", rank: 2 },
            { shop_section_id: 1, title: "A", rank: 1 },
          ],
        });
      }
      throw new Error(`unexpected path: ${path}`);
    });

    const sections = await getShopSectionsList();
    expect(sections).toEqual([
      { shopSectionId: 1, title: "A" },
      { shopSectionId: 2, title: "B" },
    ]);

    await getShopSectionsList();
    expect(sectionCalls).toBe(1); // second call served from cache
    expect(meCalls).toBe(2); // shop id itself isn't cached
  });
});
