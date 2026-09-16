import { beforeEach, describe, expect, test, vi } from "vitest";

/**
 * The real bulk routes and the real lib/etsy/bulk-apply.ts over an in-memory
 * `listings` table and a recording `etsyFetch`. Only the app session, "which
 * shop is active" and the Etsy transport itself are mocked — so the ownership
 * checks, the per-listing fan-out and "nothing is sent until an explicit
 * save" are all exercised for real.
 */

const { authMock, shopMock, etsyFetchMock } = vi.hoisted(() => ({
  authMock: vi.fn(),
  shopMock: vi.fn(),
  etsyFetchMock: vi.fn(),
}));

vi.mock("@/auth", () => ({ auth: authMock }));
vi.mock("@/lib/etsy/auth", () => ({ etsyFetch: etsyFetchMock }));
// A getter, not `prisma: fakePrisma`: this factory runs while the route
// imports below are still being resolved, which is before `fakePrisma`'s own
// initialiser has run. Deferring the read to first use sidesteps that without
// hoisting the whole fake above the types it's written against.
vi.mock("@/lib/db/prisma", () => ({
  get prisma() {
    return fakePrisma;
  },
}));

interface ListingRow {
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

interface DraftRow {
  id: string;
  userId: string;
  title: string;
  sourceMode: string | null;
  sourceListingId: string | null;
}

const db = {
  listings: [] as ListingRow[],
  drafts: [] as DraftRow[],
  nextDraftId: 1,
};

/** Only the handful of operations the bulk routes actually use. */
const fakePrisma = {
  listing: {
    async findMany({ where }: { where: Record<string, unknown> }) {
      const ids = (where.listingId as { in?: string[] } | undefined)?.in;
      return db.listings.filter(
        (row) =>
          row.userId === where.userId &&
          row.shopId === where.shopId &&
          (ids ? ids.includes(row.listingId) : true) &&
          (where.removedAt === null ? row.removedAt === null : true),
      );
    },
    async updateMany({
      where,
      data,
    }: {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    }) {
      const ids = (where.listingId as { in?: string[] } | string | undefined);
      const list = typeof ids === "string" ? [ids] : (ids?.in ?? null);
      const targets = db.listings.filter(
        (row) =>
          row.userId === where.userId &&
          row.shopId === where.shopId &&
          (list ? list.includes(row.listingId) : true) &&
          (where.removedAt === null ? row.removedAt === null : true),
      );
      for (const row of targets) Object.assign(row, data);
      return { count: targets.length };
    },
  },
  listingDraft: {
    async create({ data }: { data: Omit<DraftRow, "id"> }) {
      const row: DraftRow = { id: `d${db.nextDraftId++}`, ...data };
      db.drafts.push(row);
      return row;
    },
  },
};

import { GET as GET_BULK } from "@/app/api/etsy/listings/bulk/route";
import { POST as SAVE } from "@/app/api/etsy/listings/bulk/save/route";
import { POST as DELETE_LISTINGS } from "@/app/api/etsy/listings/bulk/delete/route";
import { POST as COPY } from "@/app/api/etsy/listings/bulk/copy/route";
import { NextRequest } from "next/server";

/**
 * Real Etsy shop ids are numeric strings (`fetchShopInfoForToken` stores
 * `String(me.shop_id)`), and the save route turns one back into a number for
 * the listing path — so the fixtures have to look like the real thing.
 */
const SHOP_A = "12345678";
const SHOP_OTHER = "87654321";

function seedListing(overrides: Partial<ListingRow> & Pick<ListingRow, "userId" | "listingId">) {
  const row: ListingRow = {
    shopId: SHOP_A,
    title: `Listing ${overrides.listingId}`,
    state: "active",
    url: `https://etsy.com/listing/${overrides.listingId}`,
    quantity: 1,
    price: "$10.00",
    thumbnailUrl: null,
    endingAt: null,
    shopSectionId: null,
    sku: null,
    removedAt: null,
    ...overrides,
  };
  db.listings.push(row);
  return row;
}

function signInAs(userId: string, shopId = SHOP_A) {
  authMock.mockResolvedValue({ user: { id: userId } });
  shopMock.mockResolvedValue(shopId);
}

/** Every Etsy request made so far, as `"METHOD /path"`. */
function etsyCalls(): string[] {
  return etsyFetchMock.mock.calls.map(
    ([path, init]) => `${(init as RequestInit | undefined)?.method ?? "GET"} ${path}`,
  );
}
function etsyWrites(): string[] {
  return etsyCalls().filter((c) => !c.startsWith("GET "));
}

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status < 400,
    status,
    text: async () => JSON.stringify(body),
    headers: new Headers(),
  } as unknown as Response;
}

/** Inventory for a plain listing: one product, one offering, no variations. */
const SIMPLE_INVENTORY = {
  products: [
    {
      sku: "OLD-SKU",
      is_deleted: false,
      property_values: [],
      offerings: [{ quantity: 4, is_enabled: true, is_deleted: false, price: { amount: 1000, divisor: 100, currency_code: "USD" } }],
    },
  ],
  price_on_property: [],
  quantity_on_property: [],
  sku_on_property: [],
};

const VARIATION_INVENTORY = {
  products: [
    {
      sku: "A",
      is_deleted: false,
      property_values: [{ property_id: 200, value_ids: [1], values: ["Red"] }],
      offerings: [{ quantity: 1, is_enabled: true, price: { amount: 1000, divisor: 100, currency_code: "USD" } }],
    },
    {
      sku: "B",
      is_deleted: false,
      property_values: [{ property_id: 200, value_ids: [2], values: ["Blue"] }],
      offerings: [{ quantity: 1, is_enabled: true, price: { amount: 1200, divisor: 100, currency_code: "USD" } }],
    },
  ],
  price_on_property: [200],
  quantity_on_property: [],
  sku_on_property: [],
};

beforeEach(async () => {
  db.listings = [];
  db.drafts = [];
  db.nextDraftId = 1;
  authMock.mockReset();
  shopMock.mockReset();
  etsyFetchMock.mockReset();
  etsyFetchMock.mockResolvedValue(jsonResponse({}));

  const store = await import("@/lib/etsy/listing-store");
  vi.spyOn(store, "resolveActiveShopId").mockImplementation((userId: string) => shopMock(userId));

  signInAs("alice");
  seedListing({ userId: "alice", listingId: "101", title: "Halloween mug" });
  seedListing({ userId: "alice", listingId: "102", title: "Christmas mug" });
  seedListing({ userId: "bob", listingId: "999", title: "Bob's poster" });
});

const post = (url: string, body: unknown) =>
  new Request(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

async function save(updates: unknown) {
  const res = await SAVE(post("http://localhost/api/etsy/listings/bulk/save", { updates }));
  return { status: res.status, body: await res.json() };
}
async function remove(listingIds: unknown) {
  const res = await DELETE_LISTINGS(
    post("http://localhost/api/etsy/listings/bulk/delete", { listingIds }),
  );
  return { status: res.status, body: await res.json() };
}
async function copy(listingIds: unknown) {
  const res = await COPY(post("http://localhost/api/etsy/listings/bulk/copy", { listingIds }));
  return { status: res.status, body: await res.json() };
}
async function loadBulk(ids: string) {
  const res = await GET_BULK(
    new NextRequest(`http://localhost/api/etsy/listings/bulk?ids=${ids}`),
  );
  return { status: res.status, body: await res.json() };
}

describe("nothing reaches Etsy before an explicit save", () => {
  test("loading the bulk editor only ever reads", async () => {
    etsyFetchMock.mockResolvedValue(
      jsonResponse({ results: [{ listing_id: 101, title: "Halloween mug" }] }),
    );
    const { status } = await loadBulk("101,102");
    expect(status).toBe(200);
    expect(etsyWrites()).toEqual([]);
  });

  test("copy creates drafts and makes no Etsy call whatsoever", async () => {
    const { status, body } = await copy([101, 102]);
    expect(status).toBe(201);
    expect(body.copied).toBe(2);
    expect(etsyFetchMock).not.toHaveBeenCalled();

    expect(db.drafts).toHaveLength(2);
    expect(db.drafts[0]).toMatchObject({
      userId: "alice",
      title: "Halloween mug",
      sourceMode: "copy",
      sourceListingId: "101",
    });
    // The live listings are untouched.
    expect(db.listings.find((l) => l.listingId === "101")).toMatchObject({ title: "Halloween mug" });
  });

  test("a save with nothing changed is refused before any Etsy call", async () => {
    const { status, body } = await save([{ listingId: 101, patch: {} }]);
    expect(status).toBe(400);
    expect(body.error).toBe("Nothing to save.");
    expect(etsyFetchMock).not.toHaveBeenCalled();
  });

  test("an invalid value fails the save without writing any listing", async () => {
    const { status } = await save([
      { listingId: 101, patch: { title: "fine" } },
      { listingId: 102, patch: { title: "" } },
    ]);
    expect(status).toBe(400);
    expect(etsyFetchMock).not.toHaveBeenCalled();
  });
});

describe("saving writes each listing only its own fields", () => {
  test("two listings, two different fields", async () => {
    const { status, body } = await save([
      { listingId: 101, patch: { title: "Renamed mug" } },
      { listingId: 102, patch: { tags: ["holiday", "gift"] } },
    ]);
    expect(status).toBe(200);
    expect(body.saved).toBe(2);
    expect(body.failed).toBe(0);

    const calls = etsyFetchMock.mock.calls.filter(([, init]) => init?.method === "PATCH");
    expect(calls).toHaveLength(2);

    const [path101, init101] = calls.find(([p]) => String(p).includes("/101"))!;
    expect(path101).toBe(`/shops/${SHOP_A}/listings/101`);
    const body101 = new URLSearchParams(init101!.body as string);
    expect(body101.get("title")).toBe("Renamed mug");
    expect(body101.has("tags")).toBe(false);

    const [, init102] = calls.find(([p]) => String(p).includes("/102"))!;
    const body102 = new URLSearchParams(init102!.body as string);
    expect(body102.getAll("tags")).toEqual(["holiday", "gift"]);
    expect(body102.has("title")).toBe(false);
  });

  test("the cached rows the listings table reads are updated to match", async () => {
    await save([{ listingId: 101, patch: { title: "Renamed mug" } }]);
    expect(db.listings.find((l) => l.listingId === "101")!.title).toBe("Renamed mug");
    expect(db.listings.find((l) => l.listingId === "102")!.title).toBe("Christmas mug");
  });

  test("one listing failing doesn't stop the other, and is reported per row", async () => {
    etsyFetchMock.mockImplementation(async (path: string) =>
      String(path).includes("/102")
        ? jsonResponse({ error: "Etsy said no." }, 400)
        : jsonResponse({}),
    );
    const { body } = await save([
      { listingId: 101, patch: { title: "Fine" } },
      { listingId: 102, patch: { title: "Doomed" } },
    ]);
    expect(body.saved).toBe(1);
    expect(body.failed).toBe(1);
    expect(body.results).toContainEqual({ listingId: 101, ok: true });
    expect(body.results).toContainEqual({
      listingId: 102,
      ok: false,
      error: "Etsy said no.",
    });
    // Only the listing that actually saved is mirrored into the cache.
    expect(db.listings.find((l) => l.listingId === "101")!.title).toBe("Fine");
    expect(db.listings.find((l) => l.listingId === "102")!.title).toBe("Christmas mug");
  });
});

describe("inventory fields go through the inventory record", () => {
  test("price, quantity and SKU are read then written back, keeping the rest", async () => {
    etsyFetchMock.mockImplementation(async (path: string, init?: RequestInit) => {
      if (String(path).includes("/inventory") && (!init || !init.method || init.method === "GET")) {
        return jsonResponse(SIMPLE_INVENTORY);
      }
      return jsonResponse({});
    });

    const { body } = await save([{ listingId: 101, patch: { price: 25.5, quantity: 9 } }]);
    expect(body.saved).toBe(1);

    const put = etsyFetchMock.mock.calls.find(([, init]) => init?.method === "PUT")!;
    expect(put[0]).toBe("/listings/101/inventory");
    const sent = JSON.parse(put[1]!.body as string);
    expect(sent.products[0].offerings[0]).toMatchObject({ price: 25.5, quantity: 9, is_enabled: true });
    // The SKU the user didn't touch survives the replace.
    expect(sent.products[0].sku).toBe("OLD-SKU");
  });

  test("a variation listing is refused with an explanation instead of flattened", async () => {
    etsyFetchMock.mockImplementation(async (path: string, init?: RequestInit) => {
      if (String(path).includes("/inventory") && (!init || !init.method || init.method === "GET")) {
        return jsonResponse(VARIATION_INVENTORY);
      }
      return jsonResponse({});
    });

    const { body } = await save([{ listingId: 101, patch: { price: 5 } }]);
    expect(body.failed).toBe(1);
    expect(body.results[0].error).toMatch(/variation separately/i);
    // Nothing was written to the inventory.
    expect(etsyFetchMock.mock.calls.some(([, init]) => init?.method === "PUT")).toBe(false);
  });
});

describe("deleting", () => {
  test("deletes on Etsy and marks the cached row removed", async () => {
    etsyFetchMock.mockResolvedValue(jsonResponse({}, 204));
    const { status, body } = await remove([101]);
    expect(status).toBe(200);
    expect(body.deleted).toBe(1);
    expect(etsyCalls()).toContain("DELETE /listings/101");
    expect(db.listings.find((l) => l.listingId === "101")!.removedAt).toBeInstanceOf(Date);
    expect(db.listings.find((l) => l.listingId === "102")!.removedAt).toBeNull();
  });

  test("a listing Etsy refuses keeps its cached row", async () => {
    etsyFetchMock.mockResolvedValue(
      jsonResponse({ error: "Insufficient scope: listings_d required." }, 403),
    );
    const { body } = await remove([101]);
    expect(body.failed).toBe(1);
    expect(body.results[0].error).toMatch(/listings_d/);
    expect(db.listings.find((l) => l.listingId === "101")!.removedAt).toBeNull();
  });
});

describe("cross-user isolation", () => {
  beforeEach(() => {
    // Bob is connected to the very same shop id — ownership still has to hold.
    signInAs("bob", SHOP_A);
  });

  test("another user's listing can't be edited — reported not found, never sent to Etsy", async () => {
    const { body } = await save([{ listingId: 101, patch: { title: "Hijacked" } }]);
    expect(body.saved).toBe(0);
    expect(body.results).toEqual([{ listingId: 101, ok: false, error: "Listing not found." }]);
    expect(etsyWrites()).toEqual([]);
    expect(db.listings.find((l) => l.listingId === "101")!.title).toBe("Halloween mug");
  });

  test("another user's listing can't be deleted", async () => {
    const { body } = await remove([101]);
    expect(body.deleted).toBe(0);
    expect(body.results[0]).toMatchObject({ ok: false, error: "Listing not found." });
    expect(etsyFetchMock).not.toHaveBeenCalled();
    expect(db.listings.find((l) => l.listingId === "101")!.removedAt).toBeNull();
  });

  test("another user's listing can't be copied into a draft", async () => {
    const { status } = await copy([101]);
    expect(status).toBe(404);
    expect(db.drafts).toHaveLength(0);
  });

  test("another user's listing isn't loaded into the bulk editor", async () => {
    const { body } = await loadBulk("101");
    expect(body.listings).toEqual([]);
    expect(body.missing).toEqual([101]);
    expect(etsyFetchMock).not.toHaveBeenCalled();
  });

  test("a mixed save writes only the caller's own listing", async () => {
    seedListing({ userId: "bob", listingId: "777", title: "Bob's mug" });
    const { body } = await save([
      { listingId: 777, patch: { title: "Mine" } },
      { listingId: 101, patch: { title: "Not mine" } },
    ]);
    expect(body.saved).toBe(1);
    const patched = etsyFetchMock.mock.calls.filter(([, init]) => init?.method === "PATCH");
    expect(patched).toHaveLength(1);
    expect(patched[0][0]).toBe(`/shops/${SHOP_A}/listings/777`);
  });

  test("the owner's own listing in a shop that isn't active is out of reach too", async () => {
    signInAs("alice", SHOP_OTHER);
    const { body } = await save([{ listingId: 101, patch: { title: "Wrong shop" } }]);
    expect(body.results).toEqual([{ listingId: 101, ok: false, error: "Listing not found." }]);
    expect(etsyWrites()).toEqual([]);
  });
});

describe("signed out and not connected", () => {
  test("401 when signed out", async () => {
    authMock.mockResolvedValue(null);
    expect((await save([{ listingId: 101, patch: { title: "x" } }])).status).toBe(401);
    expect((await remove([101])).status).toBe(401);
    expect((await copy([101])).status).toBe(401);
    expect(etsyFetchMock).not.toHaveBeenCalled();
  });
});
