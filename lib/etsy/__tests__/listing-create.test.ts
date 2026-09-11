import { beforeEach, describe, expect, test, vi } from "vitest";

const etsyFetch = vi.fn<(path: string, init?: RequestInit) => Promise<Response>>();
vi.mock("@/lib/etsy/auth", () => ({
  etsyFetch: (path: string, init?: RequestInit) => etsyFetch(path, init),
}));

import {
  createDraftListing,
  setListingInventorySku,
  setListingProperty,
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
