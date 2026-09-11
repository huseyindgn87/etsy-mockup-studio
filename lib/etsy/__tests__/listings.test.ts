import { beforeEach, describe, expect, test, vi } from "vitest";

const etsyFetch = vi.fn<(path: string) => Promise<Response>>();
vi.mock("@/lib/etsy/auth", () => ({ etsyFetch: (path: string) => etsyFetch(path) }));

import { fetchAllShopListings, fetchShopListings, getShopName } from "@/lib/etsy/listings";

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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  etsyFetch.mockReset();
});

describe("fetchAllShopListings", () => {
  test("a single page (count within the page size) makes one request", async () => {
    etsyFetch.mockImplementation(async (path: string) => {
      if (path.includes("/users/me")) return json({ user_id: 1, shop_id: 42 });
      if (path.includes("/shops/42/listings?")) {
        expect(path).toContain("offset=0");
        expect(path).toContain("includes=Images");
        return json({
          count: 2,
          results: [RAW_LISTING(1, "Miami skyline print", true), RAW_LISTING(2, "Chicago mug", true)],
        });
      }
      throw new Error(`unexpected path: ${path}`);
    });

    const page = await fetchAllShopListings();
    expect(page.count).toBe(2);
    expect(page.listings.map((l) => l.title)).toEqual(["Miami skyline print", "Chicago mug"]);
    expect(etsyFetch.mock.calls.filter(([p]) => p.includes("/shops/42/listings?"))).toHaveLength(1);
  });

  test("pages until the reported count is exhausted, reassembled in offset order even if pages resolve out of order", async () => {
    // 3 pages of 100 = 250 total; make the LATER offsets resolve FIRST to
    // prove the result isn't just request-completion order.
    const delays: Record<number, number> = { 0: 30, 100: 10, 200: 0 };
    etsyFetch.mockImplementation(async (path: string) => {
      if (path.includes("/users/me")) return json({ user_id: 1, shop_id: 42 });
      const m = /offset=(\d+)/.exec(path);
      const offset = m ? Number(m[1]) : 0;
      await sleep(delays[offset] ?? 0);
      const count = 250;
      const pageSize = Math.min(100, count - offset);
      const results = Array.from({ length: pageSize }, (_, i) =>
        RAW_LISTING(offset + i, `Listing ${offset + i}`, true),
      );
      return json({ count, results });
    });

    const page = await fetchAllShopListings();
    expect(page.count).toBe(250);
    expect(page.listings).toHaveLength(250);
    // reassembled in ascending offset order, not resolution order
    expect(page.listings.map((l) => l.listingId)).toEqual(
      Array.from({ length: 250 }, (_, i) => i),
    );
    const pageCalls = etsyFetch.mock.calls.filter(([p]) => p.includes("/shops/42/listings?"));
    expect(pageCalls).toHaveLength(3);
  });

  test("passes the requested state through to every page", async () => {
    etsyFetch.mockImplementation(async (path: string) => {
      if (path.includes("/users/me")) return json({ user_id: 1, shop_id: 42 });
      if (path.includes("/shops/42/listings?")) {
        expect(path).toContain("state=draft");
        return json({ count: 1, results: [RAW_LISTING(9, "Draft thing")] });
      }
      throw new Error(`unexpected path: ${path}`);
    });
    const page = await fetchAllShopListings({ state: "draft" });
    expect(page.listings).toHaveLength(1);
  });
});

describe("getShopName", () => {
  test("maps shop_name and caches per shop", async () => {
    let shopCalls = 0;
    etsyFetch.mockImplementation(async (path: string) => {
      if (path.includes("/users/me")) return json({ user_id: 1, shop_id: 99 });
      if (path === "/shops/99") {
        shopCalls++;
        return json({ shop_id: 99, shop_name: "Cool Shop" });
      }
      throw new Error(`unexpected path: ${path}`);
    });

    expect(await getShopName()).toBe("Cool Shop");
    expect(await getShopName()).toBe("Cool Shop");
    expect(shopCalls).toBe(1); // second call served from cache
  });
});

describe("fetchShopListings (unaffected by fetchAllShopListings)", () => {
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
