import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findFirst: vi.fn(),
  fetchListingDetails: vi.fn(),
  fetchListingAttributes: vi.fn(),
  fetchListingInventories: vi.fn(),
  getSellerTaxonomyTree: vi.fn(),
}));

vi.mock("@/lib/db/prisma", () => ({ prisma: { listing: { findFirst: mocks.findFirst } } }));
vi.mock("@/lib/etsy/listing-details", () => ({ fetchListingDetails: mocks.fetchListingDetails }));
vi.mock("@/lib/etsy/listing-attributes", () => ({ fetchListingAttributes: mocks.fetchListingAttributes }));
vi.mock("@/lib/etsy/listing-inventory", () => ({ fetchListingInventories: mocks.fetchListingInventories }));
vi.mock("@/lib/etsy/taxonomy", () => ({ getSellerTaxonomyTree: mocks.getSellerTaxonomyTree }));

import { loadListingForEditor } from "@/lib/etsy/listing-editor-load";

const detail = {
  listingId: 5,
  shopId: 63307885,
  title: "Live title",
  description: "Live description",
  tags: ["live"],
  price: 12,
  quantity: 3,
  sku: "LIVE",
  shopSectionId: null,
  readinessStateId: 88,
  taxonomyId: 2,
  whoMade: "i_did",
  whenMade: "made_to_order",
  isSupply: false,
  productionPartnerIds: [4],
  personalizationQuestions: [],
  featured: true,
  shouldAutoRenew: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.fetchListingDetails.mockResolvedValue([detail]);
  mocks.fetchListingAttributes.mockResolvedValue(
    new Map([[5, [{ propertyId: 200, propertyName: "Color", scaleId: null, valueIds: [1], values: ["Red"] }]]]),
  );
  mocks.fetchListingInventories.mockResolvedValue(new Map());
  mocks.getSellerTaxonomyTree.mockResolvedValue([
    { id: 1, level: 0, name: "Clothing", parentId: null, children: [{ id: 2, level: 1, name: "Shirts", parentId: 1, children: [] }] },
  ]);
});

describe("loadListingForEditor", () => {
  it("takes the listing's own fields from the cache and only the uncached ones from Etsy", async () => {
    mocks.findFirst.mockResolvedValue({
      listingId: "5",
      title: "Cached title",
      description: "Cached description",
      tags: ["cached"],
      quantity: 9,
      sku: "CACHED",
      shopSectionId: 3,
      whoMade: "someone_else",
      whenMade: "made_to_order",
      isSupply: false,
      priceAmount: 2500,
      priceDivisor: 100,
      isPersonalizable: false,
      personalizationIsRequired: false,
      personalizationInstructions: null,
      personalizationCharCountMax: null,
      syncedAt: new Date(),
      inventoryProperties: [],
      inventoryProducts: [],
    });

    const loaded = await loadListingForEditor("u1", "63307885", 5);

    expect(loaded?.source).toBe("cache");
    expect(loaded?.form).toMatchObject({
      title: "Cached title",
      description: "Cached description",
      tags: ["cached"],
      price: "25.00",
      quantity: "9",
      sku: "CACHED",
      shopSectionId: 3,
      whoMade: "someone_else",
      taxonomyId: 2,
      taxonomyPath: "Clothing > Shirts",
      properties: { 200: { name: "Color", valueIds: [1], values: ["Red"], scaleId: null } },
      productionPartnerIds: [4],
      readinessStateId: 88,
      featureListing: true,
      autoRenew: false,
    });
    expect(mocks.fetchListingInventories).not.toHaveBeenCalled();
    expect(mocks.findFirst.mock.calls[0][0].where).toEqual({ userId: "u1", shopId: "63307885", listingId: "5", removedAt: null });
  });

  it("reads the whole listing from Etsy when the cache row is missing", async () => {
    mocks.findFirst.mockResolvedValue(null);
    const loaded = await loadListingForEditor("u1", "63307885", 5);
    expect(loaded?.source).toBe("etsy");
    expect(loaded?.form).toMatchObject({ title: "Live title", price: "12.00", quantity: "3", sku: "LIVE" });
    expect(mocks.fetchListingInventories).toHaveBeenCalledWith([5]);
  });

  it("refuses a listing from another shop", async () => {
    mocks.findFirst.mockResolvedValue(null);
    mocks.fetchListingDetails.mockResolvedValue([{ ...detail, shopId: 1 }]);
    expect(await loadListingForEditor("u1", "63307885", 5)).toBeNull();
  });
});
