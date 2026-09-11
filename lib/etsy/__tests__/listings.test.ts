import { beforeEach, describe, expect, test, vi } from "vitest";

const etsyFetch = vi.fn<(path: string) => Promise<Response>>();
vi.mock("@/lib/etsy/auth", () => ({ etsyFetch: (path: string) => etsyFetch(path) }));

import { fetchShopListings, searchShopListings } from "@/lib/etsy/listings";

const json = (body: unknown, ok = true, status = 200): Response =>
  ({ ok, status, json: async () => body }) as Response;

const RAW_LISTING = (id: number, title: string, withImage = false) => ({
  listing_id: id,
  title,
  state: "active",
  url: `https://etsy.com/listing/${id}`,
  quantity: 1,
  price: { amount: 1999, divisor: 100, currency_code: "USD" },
  ...(withImage ? { images: [{ url_570xN: `https://img/${id}.jpg` }] } : {}),
});

beforeEach(() => {
  etsyFetch.mockReset();
});

describe("searchShopListings", () => {
  test("empty keywords falls back to the plain listing feed", async () => {
    etsyFetch.mockImplementation(async (path: string) => {
      if (path.includes("/users/me")) return json({ user_id: 1, shop_id: 42 });
      if (path.includes("/shops/42/listings?")) {
        return json({ count: 1, results: [RAW_LISTING(1, "Mug", true)] });
      }
      throw new Error(`unexpected path: ${path}`);
    });

    const page = await searchShopListings({ keywords: "   " });
    expect(page.listings).toHaveLength(1);
    expect(page.listings[0].title).toBe("Mug");
    // no search/batch calls were made
    expect(etsyFetch.mock.calls.some(([p]) => p.includes("/listings/active"))).toBe(false);
    expect(etsyFetch.mock.calls.some(([p]) => p.includes("/listings/batch"))).toBe(false);
  });

  test("searches active listings then batches images, preserving relevance order", async () => {
    const calls: string[] = [];
    etsyFetch.mockImplementation(async (path: string) => {
      calls.push(path);
      if (path.includes("/users/me")) return json({ user_id: 1, shop_id: 42 });
      if (path.includes("/shops/42/listings/active")) {
        expect(path).toContain("keywords=tumbler");
        expect(path).toContain("sort_on=score");
        // relevance order: 30 is the best match, then 10, then 20
        return json({ count: 3, results: [{ listing_id: 30 }, { listing_id: 10 }, { listing_id: 20 }] });
      }
      if (path.includes("/listings/batch")) {
        expect(path).toContain("includes=Images");
        expect(path).toContain("listing_ids=30");
        expect(path).toContain("listing_ids=10");
        expect(path).toContain("listing_ids=20");
        // batch endpoint returns them in a DIFFERENT order than requested
        return json({
          count: 3,
          results: [
            RAW_LISTING(10, "Steel tumbler", true),
            RAW_LISTING(20, "Coffee tumbler", true),
            RAW_LISTING(30, "Travel tumbler", true),
          ],
        });
      }
      throw new Error(`unexpected path: ${path}`);
    });

    const page = await searchShopListings({ keywords: "tumbler", limit: 10 });
    expect(page.shopId).toBe(42);
    expect(page.count).toBe(3);
    // re-sorted back to the search's own relevance order (30, 10, 20)
    expect(page.listings.map((l) => l.listingId)).toEqual([30, 10, 20]);
    expect(page.listings.map((l) => l.title)).toEqual([
      "Travel tumbler",
      "Steel tumbler",
      "Coffee tumbler",
    ]);
    expect(page.listings[0].thumbnailUrl).toBe("https://img/30.jpg");
    expect(calls.filter((p) => p.includes("/listings/batch"))).toHaveLength(1);
  });

  test("no matches short-circuits without a batch call", async () => {
    etsyFetch.mockImplementation(async (path: string) => {
      if (path.includes("/users/me")) return json({ user_id: 1, shop_id: 42 });
      if (path.includes("/listings/active")) return json({ count: 0, results: [] });
      throw new Error(`unexpected path: ${path}`);
    });

    const page = await searchShopListings({ keywords: "xyzzy-nonexistent" });
    expect(page.listings).toEqual([]);
    expect(page.count).toBe(0);
    expect(etsyFetch.mock.calls.some(([p]) => p.includes("/listings/batch"))).toBe(false);
  });
});

describe("fetchShopListings (unaffected by the search addition)", () => {
  test("still maps a plain listing page", async () => {
    etsyFetch.mockImplementation(async (path: string) => {
      if (path.includes("/users/me")) return json({ user_id: 1, shop_id: 7 });
      if (path.includes("/shops/7/listings?")) {
        return json({ count: 1, results: [RAW_LISTING(5, "Sticker", true)] });
      }
      throw new Error(`unexpected path: ${path}`);
    });
    const page = await fetchShopListings({ state: "active" });
    expect(page.listings[0]).toMatchObject({ listingId: 5, title: "Sticker" });
  });
});
