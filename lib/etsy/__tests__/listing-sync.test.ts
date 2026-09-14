import { beforeEach, describe, expect, test, vi } from "vitest";

interface Row {
  userId: string;
  shopId: string;
  listingId: string;
  title: string;
  state: string;
  url: string;
  quantity: number;
  price: string | null;
  thumbnailUrl: string | null;
  endingAt: Date | null;
  shopSectionId: number | null;
  sku: string | null;
  removedAt: Date | null;
}

const rows = new Map<string, Row>();
const rowKey = (userId: string, shopId: string, listingId: string) => `${userId}:${shopId}:${listingId}`;

function seedRow(row: Row) {
  rows.set(rowKey(row.userId, row.shopId, row.listingId), row);
}

vi.mock("@/lib/db/prisma", () => {
  const listing = {
    findMany: vi.fn(async ({ where }: { where: { userId: string; shopId: string } }) =>
      [...rows.values()]
        .filter((r) => r.userId === where.userId && r.shopId === where.shopId)
        .map((r) => ({ listingId: r.listingId, removedAt: r.removedAt })),
    ),
    updateMany: vi.fn(
      async ({
        where,
        data,
      }: {
        where: { userId: string; shopId: string; listingId: { notIn: string[] }; removedAt: null };
        data: { removedAt: Date };
      }) => {
        for (const r of rows.values()) {
          if (
            r.userId === where.userId &&
            r.shopId === where.shopId &&
            !where.listingId.notIn.includes(r.listingId) &&
            !r.removedAt
          ) {
            Object.assign(r, data);
          }
        }
      },
    ),
  };

  // Mirrors `batchUpsertListings`' template: one `${...}` interpolation per
  // VALUES row, itself built with `Prisma.join(valueRows)` — so `exprs[0]`
  // here is that joined `Prisma.Sql`, whose real (unmocked) `.values` is the
  // flat, ordered list of every row's 13 bound params (id, userId, shopId,
  // listingId, title, state, url, quantity, price, thumbnailUrl, endingAt,
  // shopSectionId, sku — `NULL`/`NOW()` are literal SQL text, not params).
  const COLUMNS_PER_ROW = 13;
  const $executeRaw = vi.fn(async (_strings: TemplateStringsArray, ...exprs: unknown[]) => {
    const joined = exprs[0] as { values: unknown[] };
    for (let i = 0; i < joined.values.length; i += COLUMNS_PER_ROW) {
      const [, userId, shopId, listingId, title, state, url, quantity, price, thumbnailUrl, endingAt, shopSectionId, sku] =
        joined.values.slice(i, i + COLUMNS_PER_ROW) as [
          string, string, string, string, string, string, string, number,
          string | null, string | null, Date | null, number | null, string | null,
        ];
      rows.set(rowKey(userId, shopId, listingId), {
        userId, shopId, listingId, title, state, url, quantity, price, thumbnailUrl,
        endingAt, shopSectionId, sku, removedAt: null,
      });
    }
  });

  const client = {
    listing,
    $executeRaw,
    $transaction: vi.fn(async (cb: (tx: typeof client) => Promise<void>) => cb(client)),
  };
  return { prisma: client };
});

const etsyFetch = vi.fn<(path: string) => Promise<Response>>();
vi.mock("@/lib/etsy/auth", () => ({ etsyFetch: (path: string) => etsyFetch(path) }));

import { syncShopListings, type RefreshProgressEvent } from "../listing-sync";

const json = (body: unknown, ok = true, status = 200): Response =>
  ({ ok, status, json: async () => body, text: async () => JSON.stringify(body) }) as Response;

const RAW_LISTING = (id: number, title: string, state = "active") => ({
  listing_id: id,
  title,
  state,
  url: `https://etsy.com/listing/${id}`,
  quantity: 1,
  price: { amount: 1999, divisor: 100, currency_code: "USD" },
  images: [{ url_570xN: `https://img/${id}.jpg` }],
});

const noSkus = () => json({ count: 0, results: [] });

/** Serves `count` listings for `state`, paginated 100 per page, 0 for every other state. */
function stateListingsHandler(
  shopId: number,
  counts: Partial<Record<string, number>>,
  onPageFetched?: (state: string, offset: number) => void,
) {
  return async (path: string): Promise<Response> => {
    if (path.includes("/listings/batch/inventory")) return noSkus();
    const m = new RegExp(`/shops/${shopId}/listings\\?(.+)`).exec(path);
    if (!m) throw new Error(`unexpected path: ${path}`);
    const params = new URLSearchParams(m[1]);
    const state = params.get("state")!;
    const offset = Number(params.get("offset"));
    onPageFetched?.(state, offset);
    const count = counts[state] ?? 0;
    const pageSize = Math.max(0, Math.min(100, count - offset));
    const results = Array.from({ length: pageSize }, (_, i) =>
      RAW_LISTING(offset + i + 1, `${state} listing ${offset + i + 1}`, state),
    );
    return json({ count, results });
  };
}

function collect(): { events: RefreshProgressEvent[]; onEvent: (e: RefreshProgressEvent) => void } {
  const events: RefreshProgressEvent[] = [];
  return { events, onEvent: (e) => events.push(e) };
}

beforeEach(() => {
  etsyFetch.mockReset();
  rows.clear();
});

describe("syncShopListings pagination", () => {
  test("pulls every page across every state until each state's count is exhausted", async () => {
    const seenPages: Array<{ state: string; offset: number }> = [];
    etsyFetch.mockImplementation(
      stateListingsHandler(100, { active: 250, draft: 50 }, (state, offset) =>
        seenPages.push({ state, offset }),
      ),
    );

    const { onEvent, events } = collect();
    const result = await syncShopListings("u1", "100", onEvent);

    // active: 3 pages (0,100,200), draft + inactive + sold_out + expired: 1 page each (0) = 7 pages
    expect(seenPages).toHaveLength(7);
    expect(seenPages.filter((p) => p.state === "active").map((p) => p.offset).sort((a, b) => a - b)).toEqual([
      0, 100, 200,
    ]);
    expect(result.total).toBe(300); // 250 active + 50 draft
    expect(result.inserted).toBe(300);

    const finalProgress = events.filter((e): e is Extract<RefreshProgressEvent, { type: "progress" }> => e.type === "progress").at(-1);
    expect(finalProgress?.fetched).toBe(300);
    expect(finalProgress?.total).toBe(300);
    expect(events[0]).toEqual({ type: "status", message: "Preparing to refresh" });
  });
});

describe("syncShopListings upsert reconciliation", () => {
  test("updates existing rows, inserts new ones, and marks rows no longer on Etsy as removed", async () => {
    seedRow({
      userId: "u1",
      shopId: "200",
      listingId: "1",
      title: "Stale title",
      state: "active",
      url: "https://etsy.com/listing/1",
      quantity: 1,
      price: "$1.00",
      thumbnailUrl: null,
      endingAt: null,
      shopSectionId: null,
      sku: null,
      removedAt: null,
    });
    seedRow({
      userId: "u1",
      shopId: "200",
      listingId: "999",
      title: "No longer on Etsy",
      state: "active",
      url: "https://etsy.com/listing/999",
      quantity: 1,
      price: "$1.00",
      thumbnailUrl: null,
      endingAt: null,
      shopSectionId: null,
      sku: null,
      removedAt: null,
    });

    // Etsy now reports only listing 1 (title changed) — listing 999 is gone.
    etsyFetch.mockImplementation(async (path: string) => {
      if (path.includes("/listings/batch/inventory")) return noSkus();
      const m = /state=([a-z_]+)/.exec(path);
      const state = m?.[1] ?? "";
      if (state === "active") {
        return json({ count: 1, results: [RAW_LISTING(1, "Fresh title", "active")] });
      }
      return json({ count: 0, results: [] });
    });

    const { onEvent } = collect();
    const result = await syncShopListings("u1", "200", onEvent);

    expect(result).toEqual({ inserted: 0, updated: 1, removed: 1, total: 1 });

    const updatedRow = rows.get(rowKey("u1", "200", "1"))!;
    expect(updatedRow.title).toBe("Fresh title");
    expect(updatedRow.removedAt).toBeNull();

    const removedRow = rows.get(rowKey("u1", "200", "999"))!;
    expect(removedRow.removedAt).not.toBeNull();
  });

  test("inserts a brand-new listing not previously stored", async () => {
    etsyFetch.mockImplementation(async (path: string) => {
      if (path.includes("/listings/batch/inventory")) return noSkus();
      const m = /state=([a-z_]+)/.exec(path);
      const state = m?.[1] ?? "";
      if (state === "active") {
        return json({ count: 1, results: [RAW_LISTING(5, "Brand new", "active")] });
      }
      return json({ count: 0, results: [] });
    });

    const { onEvent } = collect();
    const result = await syncShopListings("u1", "300", onEvent);

    expect(result).toEqual({ inserted: 1, updated: 0, removed: 0, total: 1 });
    expect(rows.get(rowKey("u1", "300", "5"))?.title).toBe("Brand new");
  });
});

describe("syncShopListings failure handling", () => {
  test("a mid-refresh fetch error leaves previously stored data untouched", async () => {
    seedRow({
      userId: "u1",
      shopId: "400",
      listingId: "1",
      title: "Untouched",
      state: "active",
      url: "https://etsy.com/listing/1",
      quantity: 1,
      price: "$1.00",
      thumbnailUrl: null,
      endingAt: null,
      shopSectionId: null,
      sku: null,
      removedAt: null,
    });

    // First-page count comes back large enough to require a second page,
    // and that second page rejects — simulating a network failure partway
    // through the fetch phase, before any DB write would happen.
    etsyFetch.mockImplementation(async (path: string) => {
      if (path.includes("/listings/batch/inventory")) return noSkus();
      const m = /state=([a-z_]+)&/.exec(path) ?? /state=([a-z_]+)$/.exec(path);
      const state = m?.[1] ?? "";
      const offsetMatch = /offset=(\d+)/.exec(path);
      const offset = offsetMatch ? Number(offsetMatch[1]) : 0;
      if (state !== "active") return json({ count: 0, results: [] });
      if (offset === 0) {
        return json({ count: 150, results: Array.from({ length: 100 }, (_, i) => RAW_LISTING(i + 1, `Listing ${i + 1}`)) });
      }
      throw new Error("network error fetching page 2");
    });

    const { onEvent } = collect();
    await expect(syncShopListings("u1", "400", onEvent)).rejects.toThrow("network error fetching page 2");

    // Nothing in storage changed — the DB was never touched.
    expect(rows.size).toBe(1);
    const row = rows.get(rowKey("u1", "400", "1"))!;
    expect(row.title).toBe("Untouched");
    expect(row.removedAt).toBeNull();
  });
});
