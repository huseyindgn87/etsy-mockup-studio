import { beforeEach, describe, expect, test, vi } from "vitest";

/**
 * An in-memory stand-in for the tables the sync writes, honouring the parts
 * of Postgres the sync relies on: the listings upsert's conflict key, foreign
 * keys, cascading deletes, the unique (listingRowId, etsyPropertyId) and
 * (productId, valueId) keys, and transactions rolling back on a throw.
 */
type Row = Record<string, unknown> & { id?: string; listingRowId?: string; propertyId?: string; productId?: string; valueId?: string };
type TableName =
  | "listing"
  | "listingImage"
  | "listingVideo"
  | "listingInventoryProperty"
  | "listingInventoryValue"
  | "listingInventoryProduct"
  | "listingInventoryProductValue";

const db: Record<TableName, Row[]> & { connections: Row[] } = {
  listing: [],
  listingImage: [],
  listingVideo: [],
  listingInventoryProperty: [],
  listingInventoryValue: [],
  listingInventoryProduct: [],
  listingInventoryProductValue: [],
  connections: [],
};
const CHILD_TABLES: TableName[] = [
  "listingImage",
  "listingVideo",
  "listingInventoryProperty",
  "listingInventoryValue",
  "listingInventoryProduct",
  "listingInventoryProductValue",
];

function matches(row: Row, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([key, cond]) => {
    const value = row[key];
    if (cond && typeof cond === "object" && !(cond instanceof Date)) {
      const c = cond as { in?: unknown[]; notIn?: unknown[] };
      if (c.in) return c.in.includes(value);
      if (c.notIn) return !c.notIn.includes(value);
    }
    return cond === null ? value == null : value === cond;
  });
}

function removeWhere(table: TableName, predicate: (row: Row) => boolean): Row[] {
  const removed = db[table].filter(predicate);
  db[table] = db[table].filter((r) => !predicate(r));
  return removed;
}

function cascadeDelete(table: TableName, where: Record<string, unknown>): void {
  const removed = removeWhere(table, (r) => matches(r, where));
  const ids = removed.map((r) => r.id);
  if (table === "listingInventoryProperty") {
    const values = removeWhere("listingInventoryValue", (r) => ids.includes(r.propertyId));
    const valueIds = values.map((v) => v.id);
    removeWhere("listingInventoryProductValue", (r) => valueIds.includes(r.valueId));
  }
  if (table === "listingInventoryProduct") {
    removeWhere("listingInventoryProductValue", (r) => ids.includes(r.productId));
  }
}

const exists = (table: TableName, id: unknown) => db[table].some((r) => r.id === id);

function insertMany(table: TableName, data: Row[]): void {
  for (const input of data) {
    const row: Row = { id: input.id ?? `${table}-${Math.random().toString(36).slice(2)}`, ...input };
    if ("listingRowId" in row && !exists("listing", row.listingRowId)) throw new Error(`FK ${table}.listingRowId`);
    if (table === "listingInventoryValue" && !exists("listingInventoryProperty", row.propertyId)) {
      throw new Error("FK listingInventoryValue.propertyId");
    }
    if (table === "listingInventoryProductValue") {
      if (!exists("listingInventoryProduct", row.productId)) throw new Error("FK productValue.productId");
      if (!exists("listingInventoryValue", row.valueId)) throw new Error("FK productValue.valueId");
      if (db[table].some((r) => r.productId === row.productId && r.valueId === row.valueId)) {
        throw new Error("PK productValue");
      }
    }
    if (
      table === "listingInventoryProperty" &&
      db[table].some((r) => r.listingRowId === row.listingRowId && r.etsyPropertyId === row.etsyPropertyId)
    ) {
      throw new Error("unique listingRowId+etsyPropertyId");
    }
    db[table].push(row);
  }
}

function model(table: TableName) {
  return {
    deleteMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) => cascadeDelete(table, where)),
    createMany: vi.fn(async ({ data }: { data: Row[] }) => insertMany(table, data)),
  };
}

vi.mock("@/lib/db/prisma", () => {
  const listing = {
    findMany: vi.fn(async ({ where, select }: { where: Record<string, unknown>; select: Record<string, boolean> }) =>
      db.listing
        .filter((r) => matches(r, where))
        .map((r) => Object.fromEntries(Object.keys(select).map((k) => [k, r[k] ?? null]))),
    ),
    updateMany: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: Row }) => {
      for (const r of db.listing) if (matches(r, where)) Object.assign(r, data);
    }),
  };

  // `saveListingBatch`'s template: the column list is literal SQL text in
  // `strings[0]`; `exprs[0]` is the `Prisma.join`ed VALUES rows whose real
  // `.values` is the flat list of bound params — one per column except the
  // trailing literal `NULL, NOW(), NOW()` (removedAt, createdAt, updatedAt).
  const $executeRaw = vi.fn(async (strings: TemplateStringsArray, ...exprs: unknown[]) => {
    const columns = /"listings"\s*\(([^)]*)\)/
      .exec(strings[0])![1]
      .split(",")
      .map((c) => c.trim().replace(/"/g, ""));
    const bound = columns.slice(0, -3);
    const values = (exprs[0] as { values: unknown[] }).values;
    for (let i = 0; i < values.length; i += bound.length) {
      const input = Object.fromEntries(bound.map((c, j) => [c, values[i + j]]));
      const existing = db.listing.find(
        (r) => r.userId === input.userId && r.shopId === input.shopId && r.listingId === input.listingId,
      );
      if (existing) {
        Object.assign(existing, input, { id: existing.id, removedAt: null });
      } else {
        db.listing.push({ ...input, removedAt: null, syncedAt: null });
      }
    }
  });

  const client = {
    listing,
    etsyShopConnection: {
      findUnique: vi.fn(async ({ where }: { where: { userId_shopId: { userId: string; shopId: string } } }) => {
        const c = db.connections.find(
          (r) => r.userId === where.userId_shopId.userId && r.shopId === where.userId_shopId.shopId,
        );
        return c ? { lastSyncedAt: c.lastSyncedAt ?? null } : null;
      }),
    },
    listingImage: model("listingImage"),
    listingVideo: model("listingVideo"),
    listingInventoryProperty: model("listingInventoryProperty"),
    listingInventoryValue: model("listingInventoryValue"),
    listingInventoryProduct: model("listingInventoryProduct"),
    listingInventoryProductValue: model("listingInventoryProductValue"),
    $executeRaw,
    $transaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>): Promise<unknown> => {
      const snapshot = structuredClone({ ...db });
      try {
        return await cb(client);
      } catch (err) {
        Object.assign(db, snapshot);
        throw err;
      }
    }),
  };
  return { prisma: client };
});

const etsyFetch = vi.fn<(path: string, init?: RequestInit) => Promise<Response>>();
vi.mock("@/lib/etsy/auth", () => ({
  etsyFetch: (path: string, init?: RequestInit) => etsyFetch(path, init),
}));

import {
  INVENTORY_REQUESTS_PER_SECOND,
  syncShopListings,
  type RefreshProgressEvent,
} from "../listing-sync";

const json = (body: unknown, ok = true, status = 200): Response =>
  ({ ok, status, json: async () => body, text: async () => JSON.stringify(body) }) as Response;

type RawListing = Record<string, unknown> & { listing_id: number; state: string };

const RAW_LISTING = (id: number, title: string, state = "active", extra: Record<string, unknown> = {}): RawListing => ({
  listing_id: id,
  title,
  state,
  url: `https://etsy.com/listing/${id}`,
  quantity: 1,
  price: { amount: 1999, divisor: 100, currency_code: "USD" },
  images: [{ listing_image_id: id * 10, rank: 1, url_fullxfull: `https://img/${id}.jpg`, url_570xN: `https://img/${id}-570.jpg` }],
  ...extra,
});

const SIMPLE_INVENTORY = (price = 1999, quantity = 1, sku = "") => ({
  products: [
    {
      product_id: 1,
      sku,
      property_values: [],
      offerings: [{ offering_id: 2, quantity, is_enabled: true, price: { amount: price, divisor: 100, currency_code: "USD" } }],
    },
  ],
  price_on_property: [],
  quantity_on_property: [],
  sku_on_property: [],
});

/** A fake Etsy shop: listings per state, and each listing's inventory (or an error to answer with). */
interface FakeShop {
  shopId: number;
  listings: RawListing[];
  inventory: Map<number, unknown>;
  failInventory?: (listingId: number) => Response | null;
  /** Listings whose page carries their inventory (Etsy's `includes=Inventory`). */
  includeInventory?: (listingId: number) => boolean;
}

const inventoryCalls: number[] = [];
const pageCalls: Array<{ state: string; offset: number }> = [];

function serve(shop: FakeShop, clock?: { now: () => number }, callTimes?: number[]) {
  etsyFetch.mockImplementation(async (path: string, init?: RequestInit) => {
    if (init?.method && init.method !== "GET") throw new Error(`sync must be read-only, got ${init.method} ${path}`);
    const inv = /^\/listings\/(\d+)\/inventory$/.exec(path);
    if (inv) {
      const id = Number(inv[1]);
      inventoryCalls.push(id);
      callTimes?.push(clock!.now());
      const failure = shop.failInventory?.(id);
      if (failure) return failure;
      const body = shop.inventory.get(id);
      return body ? json(body) : json({ error: "Listing not found" }, false, 404);
    }
    const m = new RegExp(`^/shops/${shop.shopId}/listings\\?(.+)$`).exec(path);
    if (!m) throw new Error(`unexpected path: ${path}`);
    const params = new URLSearchParams(m[1]);
    expect(params.get("includes")).toBe("Images,Videos,Personalization,Inventory");
    const state = params.get("state")!;
    const offset = Number(params.get("offset"));
    pageCalls.push({ state, offset });
    const all = shop.listings.filter((l) => l.state === state);
    const page = all.slice(offset, offset + 100).map((l) =>
      shop.includeInventory?.(l.listing_id) ? { ...l, inventory: shop.inventory.get(l.listing_id) } : l,
    );
    return json({ count: all.length, results: page });
  });
}

/**
 * Virtual time. A sleeper wakes only once every pending microtask has run
 * (`setImmediate`), earliest wake time first, so concurrent workers observe
 * time the way they would with real timers.
 */
function fakeClock(start = Date.parse("2026-09-16T10:00:00Z")) {
  let t = start;
  const sleepers: { at: number; wake: () => void }[] = [];
  const release = () => {
    sleepers.sort((a, b) => a.at - b.at);
    const next = sleepers.shift();
    if (!next) return;
    t = Math.max(t, next.at);
    next.wake();
  };
  return {
    now: () => t,
    sleep: (ms: number) =>
      new Promise<void>((wake) => {
        sleepers.push({ at: t + ms, wake });
        setImmediate(release);
      }),
    advance: (ms: number) => {
      t += ms;
    },
  };
}

function collect(): { events: RefreshProgressEvent[]; onEvent: (e: RefreshProgressEvent) => void } {
  const events: RefreshProgressEvent[] = [];
  return { events, onEvent: (e) => events.push(e) };
}

/** What the route does after a successful sync (`markShopSynced`). */
function markSynced(userId: string, shopId: string, at: number) {
  const existing = db.connections.find((c) => c.userId === userId && c.shopId === shopId);
  if (existing) existing.lastSyncedAt = new Date(at);
  else db.connections.push({ userId, shopId, lastSyncedAt: new Date(at) });
}

const listingRow = (userId: string, shopId: string, listingId: string) =>
  db.listing.find((r) => r.userId === userId && r.shopId === shopId && r.listingId === listingId)!;
const childrenOf = (table: TableName, listingRowId: unknown) =>
  db[table].filter((r) => r.listingRowId === listingRowId);

beforeEach(() => {
  etsyFetch.mockReset();
  for (const key of Object.keys(db) as (keyof typeof db)[]) db[key] = [];
  inventoryCalls.length = 0;
  pageCalls.length = 0;
});

describe("inventory comes with the listing pages", () => {
  test("a shop of 250 listings costs its page calls only — no call per listing", async () => {
    const listings = Array.from({ length: 250 }, (_, i) => RAW_LISTING(i + 1, `L${i + 1}`));
    serve({
      shopId: 120,
      listings,
      inventory: new Map(listings.map((l) => [l.listing_id, SIMPLE_INVENTORY()])),
      includeInventory: () => true,
    });
    const result = await syncShopListings("u1", "120", () => {}, fakeClock());

    expect(result.total).toBe(250);
    expect(inventoryCalls).toEqual([]);
    // active: 3 pages; draft, inactive, sold_out, expired: 1 each.
    expect(pageCalls).toHaveLength(7);
    expect(db.listingInventoryProduct.length).toBe(250);
    expect(db.listing.every((r) => r.syncedAt != null)).toBe(true);
  });

  test("only a listing whose page lacks its inventory is fetched on its own", async () => {
    const listings = Array.from({ length: 5 }, (_, i) => RAW_LISTING(i + 1, `L${i + 1}`));
    serve({
      shopId: 121,
      listings,
      inventory: new Map(listings.map((l) => [l.listing_id, SIMPLE_INVENTORY()])),
      includeInventory: (id) => id !== 3,
    });
    await syncShopListings("u1", "121", () => {}, fakeClock());
    expect(inventoryCalls).toEqual([3]);
    expect(db.listingInventoryProduct.length).toBe(5);
  });
});

describe("syncShopListings pagination", () => {
  test("pulls every page across every state until each state's count is exhausted", async () => {
    const listings = [
      ...Array.from({ length: 250 }, (_, i) => RAW_LISTING(i + 1, `active ${i + 1}`, "active")),
      ...Array.from({ length: 50 }, (_, i) => RAW_LISTING(1000 + i, `draft ${i}`, "draft")),
    ];
    const clock = fakeClock();
    serve({ shopId: 100, listings, inventory: new Map(listings.map((l) => [l.listing_id, SIMPLE_INVENTORY()])) });

    const { onEvent, events } = collect();
    const result = await syncShopListings("u1", "100", onEvent, clock);

    // active: 3 pages (0,100,200), draft + inactive + sold_out + expired: 1 page each (0) = 7 pages
    expect(pageCalls).toHaveLength(7);
    expect(pageCalls.filter((p) => p.state === "active").map((p) => p.offset).sort((a, b) => a - b)).toEqual([0, 100, 200]);
    expect(result.total).toBe(300);
    expect(result.inserted).toBe(300);

    const fetchProgress = events.filter(
      (e): e is Extract<RefreshProgressEvent, { type: "progress" }> => e.type === "progress" && e.stage === "listings",
    );
    expect(fetchProgress.at(-1)).toMatchObject({ fetched: 300, total: 300 });
    expect(events[0]).toEqual({ type: "status", stage: "listings", message: "Preparing to refresh" });
  });

  test("reports every stage, in order, ending with inventory complete", async () => {
    const listings = Array.from({ length: 30 }, (_, i) => RAW_LISTING(i + 1, `L${i + 1}`));
    serve({ shopId: 110, listings, inventory: new Map(listings.map((l) => [l.listing_id, SIMPLE_INVENTORY()])) });
    const { onEvent, events } = collect();
    await syncShopListings("u1", "110", onEvent, fakeClock());

    const stages = events.flatMap((e) => (e.type === "progress" ? [e.stage] : []));
    expect([...new Set(stages)]).toEqual(["listings", "saving", "inventory"]);
    expect(events.at(-1)).toMatchObject({ type: "progress", stage: "inventory", fetched: 30, total: 30 });
  });
});

describe("syncShopListings persistence", () => {
  test("a listing with variations persists its full grid", async () => {
    const inventory = {
      products: [
        ["S", 101, "Red", 201, 2000, 3, "SKU-S-R", true],
        ["S", 101, "Blue", null, 2000, 0, "SKU-S-B", false],
        ["M", 102, "Red", 201, 2500, 5, "SKU-M-R", true],
        ["M", 102, "Blue", null, 2500, 7, "", true],
      ].map(([size, sizeId, color, colorId, price, quantity, sku, enabled], i) => ({
        product_id: 900 + i,
        sku,
        is_deleted: false,
        property_values: [
          { property_id: 100, property_name: "Size", scale_id: 5, scale_name: "Letter", value_ids: [sizeId], values: [size] },
          { property_id: 200, property_name: "Color", value_ids: colorId == null ? [] : [colorId], values: [color] },
        ],
        offerings: [
          { offering_id: 800 + i, quantity, is_enabled: enabled, is_deleted: false, readiness_state_id: 42, price: { amount: price, divisor: 100, currency_code: "USD" } },
        ],
      })),
      price_on_property: [100],
      quantity_on_property: [100, 200],
      sku_on_property: [100, 200],
    };
    // A deleted product must not appear.
    inventory.products.push({ ...inventory.products[0], product_id: 999, is_deleted: true });

    serve({ shopId: 200, listings: [RAW_LISTING(1, "Tee", "active", { has_variations: true })], inventory: new Map([[1, inventory]]) });
    await syncShopListings("u1", "200", () => {}, fakeClock());

    const listing = listingRow("u1", "200", "1");
    expect(listing.syncedAt).toBeInstanceOf(Date);

    const properties = childrenOf("listingInventoryProperty", listing.id).sort((a, b) => Number(a.rank) - Number(b.rank));
    expect(properties).toMatchObject([
      { etsyPropertyId: "100", name: "Size", scaleId: "5", scaleName: "Letter", rank: 0, priceOnProperty: true, quantityOnProperty: true, skuOnProperty: true },
      { etsyPropertyId: "200", name: "Color", scaleId: null, rank: 1, priceOnProperty: false, quantityOnProperty: true, skuOnProperty: true },
    ]);

    const valuesOf = (propertyId: unknown) =>
      db.listingInventoryValue
        .filter((v) => v.propertyId === propertyId)
        .sort((a, b) => Number(a.rank) - Number(b.rank))
        .map((v) => [v.value, v.etsyValueId]);
    expect(valuesOf(properties[0].id)).toEqual([["S", "101"], ["M", "102"]]);
    expect(valuesOf(properties[1].id)).toEqual([["Red", "201"], ["Blue", null]]);

    const products = childrenOf("listingInventoryProduct", listing.id);
    expect(products).toHaveLength(4);
    const valueName = (id: unknown) => db.listingInventoryValue.find((v) => v.id === id)!.value;
    const grid = products
      .map((p) => ({
        combo: db.listingInventoryProductValue.filter((pv) => pv.productId === p.id).map((pv) => valueName(pv.valueId)).sort(),
        etsyProductId: p.etsyProductId,
        etsyOfferingId: p.etsyOfferingId,
        priceAmount: p.priceAmount,
        priceDivisor: p.priceDivisor,
        currencyCode: p.currencyCode,
        quantity: p.quantity,
        sku: p.sku,
        isEnabled: p.isEnabled,
        readinessStateId: p.readinessStateId,
      }))
      .sort((a, b) => String(a.etsyProductId).localeCompare(String(b.etsyProductId)));
    expect(grid).toEqual([
      { combo: ["Red", "S"], etsyProductId: "900", etsyOfferingId: "800", priceAmount: 2000, priceDivisor: 100, currencyCode: "USD", quantity: 3, sku: "SKU-S-R", isEnabled: true, readinessStateId: "42" },
      { combo: ["Blue", "S"], etsyProductId: "901", etsyOfferingId: "801", priceAmount: 2000, priceDivisor: 100, currencyCode: "USD", quantity: 0, sku: "SKU-S-B", isEnabled: false, readinessStateId: "42" },
      { combo: ["M", "Red"], etsyProductId: "902", etsyOfferingId: "802", priceAmount: 2500, priceDivisor: 100, currencyCode: "USD", quantity: 5, sku: "SKU-M-R", isEnabled: true, readinessStateId: "42" },
      { combo: ["Blue", "M"], etsyProductId: "903", etsyOfferingId: "803", priceAmount: 2500, priceDivisor: 100, currencyCode: "USD", quantity: 7, sku: null, isEnabled: true, readinessStateId: "42" },
    ]);
  });

  test("a listing with personalization persists its settings", async () => {
    serve({
      shopId: 210,
      listings: [
        RAW_LISTING(1, "Name necklace", "active", {
          is_personalizable: true,
          personalization: {
            personalization_questions: [
              { question_id: 7, question_type: "text_input", question_text: "Personalization", instructions: "Enter the name", required: true, max_allowed_characters: 24 },
            ],
          },
        }),
        RAW_LISTING(2, "Plain mug", "active", { is_personalizable: false, personalization: { personalization_questions: [] } }),
      ],
      inventory: new Map([[1, SIMPLE_INVENTORY()], [2, SIMPLE_INVENTORY()]]),
    });
    await syncShopListings("u1", "210", () => {}, fakeClock());

    expect(listingRow("u1", "210", "1")).toMatchObject({
      isPersonalizable: true,
      personalizationIsRequired: true,
      personalizationInstructions: "Enter the name",
      personalizationCharCountMax: 24,
    });
    expect(listingRow("u1", "210", "2")).toMatchObject({
      isPersonalizable: false,
      personalizationIsRequired: false,
      personalizationInstructions: null,
      personalizationCharCountMax: null,
    });
  });

  test("tags, materials, shipping profile, weight and the rest of the listing fields persist, with images and videos in rank order", async () => {
    serve({
      shopId: 220,
      listings: [
        RAW_LISTING(1, "Mug &amp; saucer", "active", {
          description: "A mug &amp; a saucer",
          tags: ["mug", "coffee gift"],
          materials: ["ceramic", "glaze"],
          listing_type: "physical",
          who_made: "i_did",
          when_made: "made_to_order",
          is_supply: false,
          shipping_profile_id: 555,
          return_policy_id: 666,
          shop_section_id: 77,
          item_weight: 12.5,
          item_weight_unit: "oz",
          item_length: 4,
          item_width: 3.5,
          item_height: 5,
          item_dimensions_unit: "in",
          processing_min: 1,
          processing_max: 3,
          skus: ["", "MUG-1"],
          price: { amount: 2450, divisor: 100, currency_code: "EUR" },
          images: [
            { listing_image_id: 12, rank: 2, url_fullxfull: "https://img/b.jpg", alt_text: "Side view" },
            { listing_image_id: 11, rank: 1, url_fullxfull: "https://img/a.jpg", alt_text: "Front view" },
            { listing_image_id: 13, rank: 3, url_570xN: "https://img/c-570.jpg" },
          ],
          videos: [
            { video_id: 31, video_url: "https://vid/1.mp4", thumbnail_url: "https://vid/1.jpg", video_state: "active" },
            { video_id: 32, video_url: "https://vid/2.mp4", video_state: "deleted" },
          ],
        }),
      ],
      inventory: new Map([[1, SIMPLE_INVENTORY(2450, 1, "MUG-1")]]),
    });
    await syncShopListings("u1", "220", () => {}, fakeClock());

    const listing = listingRow("u1", "220", "1");
    expect(listing).toMatchObject({
      title: "Mug & saucer",
      description: "A mug & a saucer",
      tags: ["mug", "coffee gift"],
      materials: ["ceramic", "glaze"],
      listingType: "physical",
      whoMade: "i_did",
      whenMade: "made_to_order",
      isSupply: false,
      shippingProfileId: "555",
      returnPolicyId: "666",
      shopSectionId: 77,
      itemWeight: 12.5,
      itemWeightUnit: "oz",
      itemLength: 4,
      itemWidth: 3.5,
      itemHeight: 5,
      itemDimensionsUnit: "in",
      processingMin: 1,
      processingMax: 3,
      sku: "MUG-1",
      priceAmount: 2450,
      priceDivisor: 100,
      currencyCode: "EUR",
    });

    const images = childrenOf("listingImage", listing.id).sort((a, b) => Number(a.rank) - Number(b.rank));
    expect(images.map((i) => [i.etsyImageId, i.url, i.altText, i.rank, i.userId])).toEqual([
      ["11", "https://img/a.jpg", "Front view", 1, "u1"],
      ["12", "https://img/b.jpg", "Side view", 2, "u1"],
      ["13", "https://img/c-570.jpg", null, 3, "u1"],
    ]);
    expect(childrenOf("listingVideo", listing.id).map((v) => [v.etsyVideoId, v.url, v.thumbnailUrl, v.rank])).toEqual([
      ["31", "https://vid/1.mp4", "https://vid/1.jpg", 1],
    ]);
    expect(childrenOf("listingInventoryProduct", listing.id)).toMatchObject([{ sku: "MUG-1", priceAmount: 2450, quantity: 1 }]);
    expect(childrenOf("listingInventoryProperty", listing.id)).toHaveLength(0);
  });

  test("never sends anything but GETs to Etsy", async () => {
    const listings = [RAW_LISTING(1, "A"), RAW_LISTING(2, "B")];
    serve({ shopId: 230, listings, inventory: new Map(listings.map((l) => [l.listing_id, SIMPLE_INVENTORY()])) });
    await syncShopListings("u1", "230", () => {}, fakeClock());
    for (const [, init] of etsyFetch.mock.calls) expect(init?.method ?? "GET").toBe("GET");
  });

  test("a listing deleted on Etsy between its page and its inventory call is stored without a grid", async () => {
    serve({ shopId: 240, listings: [RAW_LISTING(1, "Gone"), RAW_LISTING(2, "Here")], inventory: new Map([[2, SIMPLE_INVENTORY()]]) });
    await syncShopListings("u1", "240", () => {}, fakeClock());
    const gone = listingRow("u1", "240", "1");
    expect(gone.syncedAt).toBeInstanceOf(Date);
    expect(childrenOf("listingInventoryProduct", gone.id)).toHaveLength(0);
    expect(childrenOf("listingInventoryProduct", listingRow("u1", "240", "2").id)).toHaveLength(1);
  });
});

describe("syncShopListings re-sync", () => {
  test("re-sync updates rows in every table instead of duplicating them", async () => {
    const variationInventory = (price: number) => ({
      products: ["S", "M"].map((size, i) => ({
        product_id: 50 + i,
        property_values: [{ property_id: 100, property_name: "Size", value_ids: [10 + i], values: [size] }],
        offerings: [{ offering_id: 60 + i, quantity: 2, is_enabled: true, price: { amount: price, divisor: 100, currency_code: "USD" } }],
      })),
      price_on_property: [],
      quantity_on_property: [],
      sku_on_property: [],
    });
    const listing = (title: string, alt: string) =>
      RAW_LISTING(1, title, "active", {
        tags: ["a"],
        images: [
          { listing_image_id: 1, rank: 1, url_fullxfull: "https://img/1.jpg", alt_text: alt },
          { listing_image_id: 2, rank: 2, url_fullxfull: "https://img/2.jpg" },
        ],
        videos: [{ video_id: 9, video_url: "https://vid/9.mp4", video_state: "active" }],
      });

    const clock = fakeClock();
    serve({ shopId: 300, listings: [listing("Old title", "old alt")], inventory: new Map([[1, variationInventory(1000)]]) });
    await syncShopListings("u1", "300", () => {}, clock);
    markSynced("u1", "300", clock.now());
    const counts = () => Object.fromEntries((["listing", ...CHILD_TABLES] as TableName[]).map((t) => [t, db[t].length]));
    const firstCounts = counts();
    const firstRowId = listingRow("u1", "300", "1").id;
    const firstSyncedAt = listingRow("u1", "300", "1").syncedAt as Date;

    clock.advance(60_000);
    serve({ shopId: 300, listings: [listing("New title", "new alt")], inventory: new Map([[1, variationInventory(1500)]]) });
    const result = await syncShopListings("u1", "300", () => {}, clock);

    expect(result).toMatchObject({ inserted: 0, updated: 1, removed: 0, total: 1, resumed: 0 });
    expect(counts()).toEqual(firstCounts);
    expect(firstCounts).toMatchObject({ listing: 1, listingImage: 2, listingVideo: 1, listingInventoryProperty: 1, listingInventoryValue: 2, listingInventoryProduct: 2, listingInventoryProductValue: 2 });

    const row = listingRow("u1", "300", "1");
    expect(row.id).toBe(firstRowId);
    expect(row.title).toBe("New title");
    expect((row.syncedAt as Date).getTime()).toBeGreaterThan(firstSyncedAt.getTime());
    expect(childrenOf("listingImage", row.id).find((i) => i.rank === 1)?.altText).toBe("new alt");
    expect(childrenOf("listingInventoryProduct", row.id).map((p) => p.priceAmount)).toEqual([1500, 1500]);
  });

  test("updates existing rows, inserts new ones, and marks rows no longer on Etsy as removed", async () => {
    const clock = fakeClock();
    serve({ shopId: 310, listings: [RAW_LISTING(1, "Stale"), RAW_LISTING(999, "Leaving")], inventory: new Map([[1, SIMPLE_INVENTORY()], [999, SIMPLE_INVENTORY()]]) });
    await syncShopListings("u1", "310", () => {}, clock);
    markSynced("u1", "310", clock.now());

    serve({ shopId: 310, listings: [RAW_LISTING(1, "Fresh"), RAW_LISTING(5, "Brand new")], inventory: new Map([[1, SIMPLE_INVENTORY()], [5, SIMPLE_INVENTORY()]]) });
    const result = await syncShopListings("u1", "310", () => {}, clock);

    expect(result).toMatchObject({ inserted: 1, updated: 1, removed: 1, total: 2 });
    expect(listingRow("u1", "310", "1")).toMatchObject({ title: "Fresh", removedAt: null });
    expect(listingRow("u1", "310", "5").title).toBe("Brand new");
    expect(listingRow("u1", "310", "999").removedAt).toBeInstanceOf(Date);
  });
});

describe("syncShopListings failure handling and resume", () => {
  test("a mid-refresh page fetch error leaves previously stored data untouched", async () => {
    const clock = fakeClock();
    serve({ shopId: 400, listings: [RAW_LISTING(1, "Untouched")], inventory: new Map([[1, SIMPLE_INVENTORY()]]) });
    await syncShopListings("u1", "400", () => {}, clock);
    const before = structuredClone(db);

    etsyFetch.mockImplementation(async (path: string) => {
      const state = /state=([a-z_]+)/.exec(path)?.[1];
      const offset = Number(/offset=(\d+)/.exec(path)?.[1] ?? 0);
      if (state !== "active") return json({ count: 0, results: [] });
      if (offset === 0) return json({ count: 150, results: Array.from({ length: 100 }, (_, i) => RAW_LISTING(i + 1, `Listing ${i + 1}`)) });
      throw new Error("network error fetching page 2");
    });
    await expect(syncShopListings("u1", "400", () => {}, clock)).rejects.toThrow("network error fetching page 2");
    expect(db).toEqual(before);
  });

  test("resumes after a mid-sync failure instead of starting over", async () => {
    const listings = Array.from({ length: 60 }, (_, i) => RAW_LISTING(i + 1, `L${i + 1}`));
    const inventory = new Map(listings.map((l) => [l.listing_id, SIMPLE_INVENTORY(1000 + l.listing_id)]));
    const clock = fakeClock();
    const shop: FakeShop = { shopId: 500, listings, inventory };

    // Etsy's listing ids come back in page order: the third inventory batch
    // (listings 51–60) hits a server error on listing 55.
    let failing = true;
    shop.failInventory = (id) => (failing && id === 55 ? json({ error: "Internal error" }, false, 500) : null);
    serve(shop);
    await expect(syncShopListings("u1", "500", () => {}, clock)).rejects.toThrow("Internal error");

    const synced = () => db.listing.filter((r) => r.syncedAt).map((r) => Number(r.listingId)).sort((a, b) => a - b);
    expect(synced()).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
    // The failed batch wrote nothing.
    expect(db.listingInventoryProduct).toHaveLength(50);

    failing = false;
    inventoryCalls.length = 0;
    clock.advance(5 * 60_000);
    const { onEvent, events } = collect();
    const result = await syncShopListings("u1", "500", onEvent, clock);

    expect(result).toMatchObject({ total: 60, inserted: 0, updated: 60, resumed: 50 });
    expect(inventoryCalls.sort((a, b) => a - b)).toEqual(Array.from({ length: 10 }, (_, i) => 51 + i));
    expect(synced()).toHaveLength(60);
    expect(db.listing).toHaveLength(60);
    expect(db.listingInventoryProduct).toHaveLength(60);
    expect(db.listingImage).toHaveLength(60);
    for (const row of db.listing) {
      expect(childrenOf("listingInventoryProduct", row.id)).toMatchObject([{ priceAmount: 1000 + Number(row.listingId) }]);
    }
    expect(events).toContainEqual(expect.objectContaining({ type: "status", stage: "inventory", message: expect.stringContaining("Resuming") }));
    expect(events.at(-1)).toMatchObject({ type: "progress", stage: "inventory", fetched: 60, total: 60 });
  });

  test("a resumed run still re-reads a listing Etsy modified after it was synced", async () => {
    const listings = Array.from({ length: 30 }, (_, i) => RAW_LISTING(i + 1, `L${i + 1}`, "active", { last_modified_timestamp: 1 }));
    const clock = fakeClock();
    const shop: FakeShop = { shopId: 510, listings, inventory: new Map(listings.map((l) => [l.listing_id, SIMPLE_INVENTORY()])) };
    let failing = true;
    shop.failInventory = (id) => (failing && id === 30 ? json({ error: "Internal error" }, false, 500) : null);
    serve(shop);
    await expect(syncShopListings("u1", "510", () => {}, clock)).rejects.toThrow();

    failing = false;
    inventoryCalls.length = 0;
    clock.advance(60_000);
    listings[2].last_modified_timestamp = Math.floor(clock.now() / 1000);
    const result = await syncShopListings("u1", "510", () => {}, clock);
    expect(result.resumed).toBe(24);
    expect(inventoryCalls.sort((a, b) => a - b)).toEqual([3, 26, 27, 28, 29, 30]);
  });

  test("a completed sync is never treated as resumable — the next run re-reads everything", async () => {
    const listings = Array.from({ length: 10 }, (_, i) => RAW_LISTING(i + 1, `L${i + 1}`));
    const clock = fakeClock();
    serve({ shopId: 520, listings, inventory: new Map(listings.map((l) => [l.listing_id, SIMPLE_INVENTORY()])) });
    await syncShopListings("u1", "520", () => {}, clock);
    markSynced("u1", "520", clock.now());
    clock.advance(1000);
    inventoryCalls.length = 0;
    const result = await syncShopListings("u1", "520", () => {}, clock);
    expect(result.resumed).toBe(0);
    expect(inventoryCalls).toHaveLength(10);
  });
});

describe("syncShopListings rate limiting", () => {
  test("a 704-listing shop completes with inventory calls never exceeding the per-second limit", async () => {
    const states = ["active", "draft", "inactive", "sold_out", "expired"];
    const listings = Array.from({ length: 704 }, (_, i) => RAW_LISTING(i + 1, `L${i + 1}`, states[i % 7 === 0 ? 1 : 0]));
    const clock = fakeClock();
    const callTimes: number[] = [];
    serve({ shopId: 600, listings, inventory: new Map(listings.map((l) => [l.listing_id, SIMPLE_INVENTORY()])) }, clock, callTimes);

    const result = await syncShopListings("u1", "600", () => {}, clock);

    expect(result.total).toBe(704);
    expect(inventoryCalls).toHaveLength(704);
    expect(new Set(inventoryCalls).size).toBe(704);
    expect(db.listing.every((r) => r.syncedAt)).toBe(true);
    const sorted = [...callTimes].sort((a, b) => a - b);
    for (let i = INVENTORY_REQUESTS_PER_SECOND; i < sorted.length; i++) {
      expect(sorted[i] - sorted[i - INVENTORY_REQUESTS_PER_SECOND]).toBeGreaterThanOrEqual(1000);
    }
  });
});

describe("syncShopListings cross-user isolation", () => {
  const richListing = (id: number, title: string) =>
    RAW_LISTING(id, title, "active", {
      tags: [title],
      images: [{ listing_image_id: id, rank: 1, url_fullxfull: `https://img/${title}.jpg`, alt_text: title }],
      videos: [{ video_id: id, video_url: `https://vid/${title}.mp4`, video_state: "active" }],
    });
  const gridInventory = (price: number) => ({
    products: ["S", "M"].map((size, i) => ({
      product_id: i + 1,
      property_values: [{ property_id: 100, property_name: "Size", value_ids: [10 + i], values: [size] }],
      offerings: [{ offering_id: i + 1, quantity: 1, is_enabled: true, price: { amount: price, divisor: 100, currency_code: "USD" } }],
    })),
  });

  test("two users syncing the same shop never read, overwrite or delete each other's rows in any table", async () => {
    const clock = fakeClock();
    serve({ shopId: 700, listings: [richListing(1, "one"), richListing(2, "two")], inventory: new Map([[1, gridInventory(100)], [2, gridInventory(200)]]) });
    await syncShopListings("alice", "700", () => {}, clock);
    markSynced("alice", "700", clock.now());
    const aliceRows = () =>
      structuredClone(
        Object.fromEntries((["listing", ...CHILD_TABLES] as TableName[]).map((t) => [t, db[t].filter((r) => r.userId === "alice")])),
      );
    const aliceBefore = aliceRows();

    // Bob's view of the same shop differs, and a later re-sync removes a
    // listing and changes a grid — none of it may touch Alice's rows.
    clock.advance(1000);
    serve({ shopId: 700, listings: [richListing(1, "bob-one"), richListing(2, "bob-two")], inventory: new Map([[1, gridInventory(900)], [2, gridInventory(900)]]) });
    const bobFirst = await syncShopListings("bob", "700", () => {}, clock);
    expect(bobFirst).toMatchObject({ inserted: 2, updated: 0, resumed: 0 });
    markSynced("bob", "700", clock.now());
    clock.advance(1000);
    serve({ shopId: 700, listings: [richListing(1, "bob-one-v2")], inventory: new Map([[1, gridInventory(950)]]) });
    const bobSecond = await syncShopListings("bob", "700", () => {}, clock);
    expect(bobSecond).toMatchObject({ inserted: 0, updated: 1, removed: 1 });

    expect(aliceRows()).toEqual(aliceBefore);
    for (const table of ["listing", ...CHILD_TABLES] as TableName[]) {
      expect(aliceBefore[table].length, table).toBeGreaterThan(0);
      expect(db[table].some((r) => r.userId === "bob"), table).toBe(true);
    }

    // Every child row belongs to the same user as the listing it hangs off.
    const ownerOfListingRow = (id: unknown) => db.listing.find((l) => l.id === id)!.userId;
    for (const table of ["listingImage", "listingVideo", "listingInventoryProperty", "listingInventoryProduct"] as TableName[]) {
      for (const r of db[table]) expect(r.userId, table).toBe(ownerOfListingRow(r.listingRowId));
    }
    for (const v of db.listingInventoryValue) {
      expect(v.userId).toBe(db.listingInventoryProperty.find((p) => p.id === v.propertyId)!.userId);
    }
    for (const pv of db.listingInventoryProductValue) {
      expect(pv.userId).toBe(db.listingInventoryProduct.find((p) => p.id === pv.productId)!.userId);
      expect(pv.userId).toBe(db.listingInventoryValue.find((v) => v.id === pv.valueId)!.userId);
    }

    // Bob's listing 1 has only his latest grid and images.
    const bobOne = listingRow("bob", "700", "1");
    expect(childrenOf("listingInventoryProduct", bobOne.id).map((p) => p.priceAmount)).toEqual([950, 950]);
    expect(childrenOf("listingImage", bobOne.id).map((i) => i.altText)).toEqual(["bob-one-v2"]);
    expect(listingRow("bob", "700", "2").removedAt).toBeInstanceOf(Date);
    expect(listingRow("alice", "700", "2").removedAt).toBeNull();
  });

  test("resume state is per user: another user's unfinished run doesn't let a sync skip listings", async () => {
    const listings = Array.from({ length: 30 }, (_, i) => RAW_LISTING(i + 1, `L${i + 1}`));
    const clock = fakeClock();
    const shop: FakeShop = { shopId: 710, listings, inventory: new Map(listings.map((l) => [l.listing_id, SIMPLE_INVENTORY()])) };
    shop.failInventory = (id) => (id === 30 ? json({ error: "Internal error" }, false, 500) : null);
    serve(shop);
    await expect(syncShopListings("alice", "710", () => {}, clock)).rejects.toThrow();

    shop.failInventory = undefined;
    inventoryCalls.length = 0;
    const result = await syncShopListings("bob", "710", () => {}, clock);
    expect(result.resumed).toBe(0);
    expect(inventoryCalls).toHaveLength(30);
  });
});
