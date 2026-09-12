import { beforeEach, describe, expect, test, vi } from "vitest";

const etsyFetch = vi.fn<(path: string, init?: RequestInit) => Promise<Response>>();
vi.mock("@/lib/etsy/auth", () => ({
  etsyFetch: (path: string, init?: RequestInit) => etsyFetch(path, init),
}));

import {
  createDraftListing,
  getListingStructure,
  setListingInventorySku,
  setListingProperty,
  updateListingInventory,
  updateVariationImages,
} from "@/lib/etsy/listing-create";

const json = (body: unknown, ok = true, status = 200): Response =>
  ({ ok, status, json: async () => body }) as Response;

beforeEach(() => {
  etsyFetch.mockReset();
});

describe("createDraftListing", () => {
  test("sends shop_section_id and every tag as a form field", async () => {
    etsyFetch.mockResolvedValue(json({ listing_id: 555 }));

    const id = await createDraftListing(42, {
      title: "Miami skyline tee",
      description: "A tee",
      quantity: 5,
      price: 19.99,
      whoMade: "i_did",
      whenMade: "made_to_order",
      taxonomyId: 777,
      shopSectionId: 88,
      tags: ["beach", "summer"],
    });

    expect(id).toBe(555);
    const [path, init] = etsyFetch.mock.calls[0];
    expect(path).toBe("/shops/42/listings");
    expect(init?.method).toBe("POST");
    const body = new URLSearchParams(init?.body as string);
    expect(body.get("taxonomy_id")).toBe("777");
    expect(body.get("shop_section_id")).toBe("88");
    expect(body.getAll("tags")).toEqual(["beach", "summer"]);
  });

  test("omits shop_section_id when not given", async () => {
    etsyFetch.mockResolvedValue(json({ listing_id: 1 }));
    await createDraftListing(42, {
      title: "T",
      description: "D",
      quantity: 1,
      price: 1,
      whoMade: "i_did",
      whenMade: "made_to_order",
      taxonomyId: 1,
    });
    const [, init] = etsyFetch.mock.calls[0];
    const body = new URLSearchParams(init?.body as string);
    expect(body.has("shop_section_id")).toBe(false);
  });

  test("sends readiness_state_id when given, omits it otherwise", async () => {
    etsyFetch.mockResolvedValue(json({ listing_id: 1 }));
    await createDraftListing(42, {
      title: "T",
      description: "D",
      quantity: 1,
      price: 1,
      whoMade: "i_did",
      whenMade: "made_to_order",
      taxonomyId: 1,
      readinessStateId: 654,
    });
    const [, withId] = etsyFetch.mock.calls[0];
    expect(new URLSearchParams(withId?.body as string).get("readiness_state_id")).toBe("654");

    etsyFetch.mockResolvedValue(json({ listing_id: 2 }));
    await createDraftListing(42, {
      title: "T",
      description: "D",
      quantity: 1,
      price: 1,
      whoMade: "i_did",
      whenMade: "made_to_order",
      taxonomyId: 1,
    });
    const [, withoutId] = etsyFetch.mock.calls[1];
    expect(new URLSearchParams(withoutId?.body as string).has("readiness_state_id")).toBe(false);
  });

  test("throws when Etsy doesn't return a listing id", async () => {
    etsyFetch.mockResolvedValue(json({}));
    await expect(
      createDraftListing(42, {
        title: "T",
        description: "D",
        quantity: 1,
        price: 1,
        whoMade: "i_did",
        whenMade: "made_to_order",
        taxonomyId: 1,
      }),
    ).rejects.toThrow();
  });
});

describe("getListingStructure", () => {
  test("extracts readiness_state_id alongside the other structural fields", async () => {
    etsyFetch.mockResolvedValue(
      json({
        title: "Tee",
        description: "A shirt",
        quantity: 3,
        price: { amount: 1999, divisor: 100, currency_code: "USD" },
        who_made: "i_did",
        when_made: "made_to_order",
        taxonomy_id: 1234,
        shipping_profile_id: 55,
        return_policy_id: 66,
        readiness_state_id: 321,
        tags: ["a"],
        materials: ["cotton"],
      }),
    );
    const structure = await getListingStructure(555);
    expect(structure.readinessStateId).toBe(321);
  });

  test("defaults readinessStateId to null when Etsy omits it", async () => {
    etsyFetch.mockResolvedValue(json({ title: "Tee" }));
    const structure = await getListingStructure(555);
    expect(structure.readinessStateId).toBeNull();
  });
});

describe("setListingProperty", () => {
  test("PUTs parallel value_ids/values to the right path", async () => {
    etsyFetch.mockResolvedValue(json({ property_id: 200 }));
    await setListingProperty(42, 555, {
      propertyId: 200,
      valueIds: [1, 2],
      values: ["Black", "Red"],
    });
    const [path, init] = etsyFetch.mock.calls[0];
    expect(path).toBe("/shops/42/listings/555/properties/200");
    expect(init?.method).toBe("PUT");
    const body = new URLSearchParams(init?.body as string);
    expect(body.getAll("value_ids")).toEqual(["1", "2"]);
    expect(body.getAll("values")).toEqual(["Black", "Red"]);
    expect(body.has("scale_id")).toBe(false);
  });

  test("includes scale_id when given", async () => {
    etsyFetch.mockResolvedValue(json({}));
    await setListingProperty(42, 555, {
      propertyId: 100,
      valueIds: [9],
      values: ["US 9"],
      scaleId: 19,
    });
    const [, init] = etsyFetch.mock.calls[0];
    const body = new URLSearchParams(init?.body as string);
    expect(body.get("scale_id")).toBe("19");
  });

  test("throws on a non-ok response", async () => {
    etsyFetch.mockResolvedValue(json({ error: "nope" }, false, 400));
    await expect(
      setListingProperty(42, 555, { propertyId: 1, valueIds: [1], values: ["x"] }),
    ).rejects.toThrow();
  });
});

describe("setListingInventorySku", () => {
  test("PUTs a single product/offering with the sku, price and quantity", async () => {
    etsyFetch.mockResolvedValue(json({}));
    await setListingInventorySku(555, { sku: "MIA-001", price: 19.99, quantity: 5 });

    const [path, init] = etsyFetch.mock.calls[0];
    expect(path).toBe("/listings/555/inventory");
    expect(init?.method).toBe("PUT");
    expect((init?.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
    const body = JSON.parse(init?.body as string);
    expect(body.products).toHaveLength(1);
    expect(body.products[0].sku).toBe("MIA-001");
    expect(body.products[0].offerings).toEqual([
      { price: 19.99, quantity: 5, is_enabled: true },
    ]);
  });

  test("floors quantity to at least 1", async () => {
    etsyFetch.mockResolvedValue(json({}));
    await setListingInventorySku(555, { sku: "X", price: 5, quantity: 0 });
    const [, init] = etsyFetch.mock.calls[0];
    const body = JSON.parse(init?.body as string);
    expect(body.products[0].offerings[0].quantity).toBe(1);
  });
});

describe("updateListingInventory", () => {
  test("PUTs one product per combination with property_values and the on-property arrays", async () => {
    etsyFetch.mockResolvedValue(json({}));
    await updateListingInventory(555, {
      products: [
        {
          sku: "TEE-BLK-S",
          propertyValues: [
            { propertyId: 200, name: "Color", valueIds: [1], values: ["Black"] },
            { propertyId: 100, name: "Size", valueIds: [9], values: ["S"] },
          ],
          price: 19.99,
          quantity: 3,
        },
        {
          propertyValues: [
            { propertyId: 200, name: "Color", valueIds: [2], values: ["Red"] },
            { propertyId: 100, name: "Size", valueIds: [9], values: ["S"] },
          ],
          price: 21.99,
          quantity: 5,
        },
      ],
      priceOnProperty: [200],
      quantityOnProperty: [200, 100],
      skuOnProperty: [200, 100],
    });

    const [path, init] = etsyFetch.mock.calls[0];
    expect(path).toBe("/listings/555/inventory?max_variations_supported=3");
    expect(init?.method).toBe("PUT");
    const body = JSON.parse(init?.body as string);
    expect(body.products).toHaveLength(2);
    expect(body.products[0]).toEqual({
      sku: "TEE-BLK-S",
      property_values: [
        { property_id: 200, property_name: "Color", value_ids: [1], values: ["Black"] },
        { property_id: 100, property_name: "Size", value_ids: [9], values: ["S"] },
      ],
      offerings: [{ price: 19.99, quantity: 3, is_enabled: true }],
    });
    expect(body.products[1].sku).toBeNull(); // sku omitted for this row
    expect(body.price_on_property).toEqual([200]);
    expect(body.quantity_on_property).toEqual([200, 100]);
    expect(body.sku_on_property).toEqual([200, 100]);
  });

  test("defaults the on-property arrays to empty when not given", async () => {
    etsyFetch.mockResolvedValue(json({}));
    await updateListingInventory(555, {
      products: [
        {
          propertyValues: [{ propertyId: 1, name: "Color", valueIds: [1], values: ["Black"] }],
          price: 10,
          quantity: 1,
        },
      ],
    });
    const [, init] = etsyFetch.mock.calls[0];
    const body = JSON.parse(init?.body as string);
    expect(body.price_on_property).toEqual([]);
    expect(body.quantity_on_property).toEqual([]);
    expect(body.sku_on_property).toEqual([]);
    expect(body.readiness_state_on_property).toEqual([]);
    expect(body.products[0].offerings[0]).not.toHaveProperty("readiness_state_id");
  });

  test("includes readiness_state_id on the offering and readiness_state_on_property when given", async () => {
    etsyFetch.mockResolvedValue(json({}));
    await updateListingInventory(555, {
      products: [
        {
          propertyValues: [{ propertyId: 1, name: "Color", valueIds: [1], values: ["Black"] }],
          price: 10,
          quantity: 1,
          readinessStateId: 18201076875,
        },
      ],
      readinessStateOnProperty: [1],
    });
    const [, init] = etsyFetch.mock.calls[0];
    const body = JSON.parse(init?.body as string);
    expect(body.products[0].offerings[0].readiness_state_id).toBe(18201076875);
    expect(body.readiness_state_on_property).toEqual([1]);
  });

  test("is_enabled defaults to true, and is never dropped when a product is explicitly disabled", async () => {
    etsyFetch.mockResolvedValue(json({}));
    await updateListingInventory(555, {
      products: [
        { propertyValues: [{ propertyId: 1, name: "Color", valueIds: [1], values: ["Black"] }], price: 10, quantity: 1 },
        {
          propertyValues: [{ propertyId: 1, name: "Color", valueIds: [2], values: ["Red"] }],
          price: 10,
          quantity: 1,
          enabled: false,
        },
      ],
    });
    const [, init] = etsyFetch.mock.calls[0];
    const body = JSON.parse(init?.body as string);
    expect(body.products).toHaveLength(2); // the disabled one is still sent, not dropped
    expect(body.products[0].offerings[0].is_enabled).toBe(true);
    expect(body.products[1].offerings[0].is_enabled).toBe(false);
  });
});

describe("updateVariationImages", () => {
  test("POSTs property/value/image triples to the right path", async () => {
    etsyFetch.mockResolvedValue(json({}));
    await updateVariationImages(42, 555, [
      { propertyId: 200, valueId: 1, imageId: 9001 },
      { propertyId: 200, valueId: 2, imageId: 9002 },
    ]);
    const [path, init] = etsyFetch.mock.calls[0];
    expect(path).toBe("/shops/42/listings/555/variation-images");
    expect(init?.method).toBe("POST");
    const body = JSON.parse(init?.body as string);
    expect(body.variation_images).toEqual([
      { property_id: 200, value_id: 1, image_id: 9001 },
      { property_id: 200, value_id: 2, image_id: 9002 },
    ]);
  });

  test("does nothing (no request) for an empty list", async () => {
    await updateVariationImages(42, 555, []);
    expect(etsyFetch).not.toHaveBeenCalled();
  });
});
