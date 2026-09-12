import { beforeEach, describe, expect, test, vi } from "vitest";

const etsyFetch = vi.fn<(path: string) => Promise<Response>>();
vi.mock("@/lib/etsy/auth", () => ({ etsyFetch: (path: string) => etsyFetch(path) }));

import {
  fetchAllShopListings,
  fetchShopListings,
  getShopListingStateCounts,
  getShopName,
} from "@/lib/etsy/listings";

const json = (body: unknown, ok = true, status = 200): Response =>
  ({ ok, status, json: async () => body, text: async () => JSON.stringify(body) }) as Response;

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
    // prove the result isn't just request-completion order. A distinct shop
    // id from the previous test — fetchAllShopListings caches per shop+state,
    // and both default to state "active".
    const delays: Record<number, number> = { 0: 30, 100: 10, 200: 0 };
    etsyFetch.mockImplementation(async (path: string) => {
      if (path.includes("/users/me")) return json({ user_id: 1, shop_id: 43 });
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
    const pageCalls = etsyFetch.mock.calls.filter(([p]) => p.includes("/shops/43/listings?"));
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

  test("decodes HTML entities in the title", async () => {
    etsyFetch.mockImplementation(async (path: string) => {
      if (path.includes("/users/me")) return json({ user_id: 1, shop_id: 9 });
      if (path.includes("/shops/9/listings?")) {
        return json({
          count: 1,
          results: [RAW_LISTING(6, "I&#39;d Rather Be Thrifting &gt;&gt;SALE&lt;&lt;")],
        });
      }
      throw new Error(`unexpected path: ${path}`);
    });
    const page = await fetchShopListings({ state: "active" });
    expect(page.listings[0].title).toBe("I'd Rather Be Thrifting >>SALE<<");
  });

  test("maps ending_timestamp (seconds -> ms) and shop_section_id", async () => {
    etsyFetch.mockImplementation(async (path: string) => {
      if (path.includes("/users/me")) return json({ user_id: 1, shop_id: 8 });
      if (path.includes("/shops/8/listings?")) {
        return json({
          count: 1,
          results: [
            { ...RAW_LISTING(6, "Expiring soon"), ending_timestamp: 1_700_000_000, shop_section_id: 55 },
          ],
        });
      }
      throw new Error(`unexpected path: ${path}`);
    });
    const page = await fetchShopListings({ state: "active" });
    expect(page.listings[0]).toMatchObject({
      endingTimestampMs: 1_700_000_000_000,
      shopSectionId: 55,
    });
  });

  test("maps a missing/zero shop_section_id to null", async () => {
    etsyFetch.mockImplementation(async (path: string) => {
      if (path.includes("/users/me")) return json({ user_id: 1, shop_id: 8 });
      if (path.includes("/shops/8/listings?")) {
        return json({ count: 1, results: [{ ...RAW_LISTING(6, "No section"), shop_section_id: 0 }] });
      }
      throw new Error(`unexpected path: ${path}`);
    });
    // fresh state ("inactive") to avoid the previous test's cached page
    const page = await fetchShopListings({ state: "inactive" });
    expect(page.listings[0].shopSectionId).toBeNull();
    expect(page.listings[0].endingTimestampMs).toBeNull();
  });

  test("caches identical shop+state+limit+offset calls", async () => {
    let calls = 0;
    etsyFetch.mockImplementation(async (path: string) => {
      if (path.includes("/users/me")) return json({ user_id: 1, shop_id: 11 });
      if (path.includes("/shops/11/listings?")) {
        calls++;
        return json({ count: 1, results: [RAW_LISTING(1, "Cached thing")] });
      }
      throw new Error(`unexpected path: ${path}`);
    });
    await fetchShopListings({ state: "active", limit: 10, offset: 0 });
    await fetchShopListings({ state: "active", limit: 10, offset: 0 });
    expect(calls).toBe(1); // second call served from cache
  });
});

describe("getShopListingStateCounts", () => {
  test("fetches every state's count with one limit:1 call each", async () => {
    const seenStates: string[] = [];
    etsyFetch.mockImplementation(async (path: string) => {
      if (path.includes("/users/me")) return json({ user_id: 1, shop_id: 21 });
      const m = /state=([a-z_]+)/.exec(path);
      const state = m?.[1] ?? "";
      seenStates.push(state);
      expect(path).toContain("limit=1");
      const counts: Record<string, number> = {
        active: 10,
        draft: 2,
        inactive: 1,
        sold_out: 0,
        expired: 5,
      };
      return json({ count: counts[state] ?? 0, results: [] });
    });

    const counts = await getShopListingStateCounts();
    expect(counts).toEqual({ active: 10, draft: 2, inactive: 1, sold_out: 0, expired: 5 });
    expect(seenStates.sort()).toEqual(["active", "draft", "expired", "inactive", "sold_out"]);
  });
});
