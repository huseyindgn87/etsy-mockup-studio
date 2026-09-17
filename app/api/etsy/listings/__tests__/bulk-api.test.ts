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
import { GET as GET_ATTRIBUTES } from "@/app/api/etsy/listings/bulk/attributes/route";
import { GET as GET_INVENTORY } from "@/app/api/etsy/listings/bulk/inventory/route";
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
async function loadAttributes(ids: string) {
  const res = await GET_ATTRIBUTES(
    new NextRequest(`http://localhost/api/etsy/listings/bulk/attributes?ids=${ids}`),
  );
  return { status: res.status, body: await res.json() };
}
async function loadInventory(ids: string) {
  const res = await GET_INVENTORY(
    new NextRequest(`http://localhost/api/etsy/listings/bulk/inventory?ids=${ids}`),
  );
  return { status: res.status, body: await res.json() };
}

/** The body of the one write made with `method`, as parsed form params. */
function writtenForm(method: string): URLSearchParams {
  const call = etsyFetchMock.mock.calls.find(([, init]) => init?.method === method)!;
  return new URLSearchParams(call[1]!.body as string);
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
    expect(body102.getAll("tags")).toEqual(["holiday,gift"]);
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

describe("the listing fields the wider editor adds", () => {
  test("materials, About and category all reach updateListing under Etsy's own names", async () => {
    const { body } = await save([
      {
        listingId: 101,
        patch: {
          materials: ["Cotton", "Linen"],
          whoMade: "i_did",
          whenMade: "made_to_order",
          isSupply: false,
          taxonomyId: 1071,
          returnPolicyId: 55,
        },
      },
    ]);
    expect(body.saved).toBe(1);

    const form = writtenForm("PATCH");
    expect(form.getAll("materials")).toEqual(["Cotton,Linen"]);
    expect(form.get("who_made")).toBe("i_did");
    expect(form.get("when_made")).toBe("made_to_order");
    expect(form.get("is_supply")).toBe("false");
    expect(form.get("taxonomy_id")).toBe("1071");
    expect(form.get("return_policy_id")).toBe("55");
  });

  test("item weight and size are sent with the units they were measured in", async () => {
    await save([
      {
        listingId: 101,
        patch: {
          itemWeight: 12.5,
          itemWeightUnit: "oz",
          itemLength: 4,
          itemWidth: 3,
          itemDimensionsUnit: "in",
        },
      },
    ]);
    const form = writtenForm("PATCH");
    expect(form.get("item_weight")).toBe("12.5");
    expect(form.get("item_weight_unit")).toBe("oz");
    expect(form.get("item_length")).toBe("4");
    expect(form.get("item_width")).toBe("3");
    expect(form.get("item_dimensions_unit")).toBe("in");
    // A dimension the user didn't set is left alone rather than zeroed.
    expect(form.has("item_height")).toBe(false);
  });

  test("production partners are sent as one comma-joined id list", async () => {
    await save([{ listingId: 101, patch: { productionPartnerIds: [66, 67] } }]);
    expect(writtenForm("PATCH").getAll("production_partner_ids")).toEqual(["66,67"]);
  });
});

/**
 * Etsy's urlencoded parser keeps only the last occurrence of a repeated key,
 * so a list sent as `tags=a&tags=b&tags=c` left the listing holding just "c" —
 * every earlier tag, including the listing's original ones, silently gone.
 */
describe("lists reach Etsy as one comma-joined field, never repeated params", () => {
  test("a four-tag save sends one tags field holding all four", async () => {
    await save([
      { listingId: 101, patch: { tags: ["original", "testtag", "testtag2", "testtag3"] } },
    ]);
    const form = writtenForm("PATCH");
    expect(form.getAll("tags")).toHaveLength(1);
    expect(form.get("tags")).toBe("original,testtag,testtag2,testtag3");
    // The raw body carries the key exactly once.
    const raw = etsyFetchMock.mock.calls.find(([, init]) => init?.method === "PATCH")![1]!.body as string;
    expect(raw.match(/(^|&)tags=/g)).toHaveLength(1);
  });

  test("materials too", async () => {
    await save([{ listingId: 101, patch: { materials: ["Cotton", "Linen", "Wool"] } }]);
    const form = writtenForm("PATCH");
    expect(form.getAll("materials")).toHaveLength(1);
    expect(form.get("materials")).toBe("Cotton,Linen,Wool");
  });
});

describe("a saved row reports what Etsy confirmed, not what was sent", () => {
  test("the result carries Etsy's own tag list", async () => {
    etsyFetchMock.mockResolvedValue(
      jsonResponse({ listing_id: 101, title: "Halloween mug", tags: ["original", "testtag"] }),
    );
    const { body } = await save([{ listingId: 101, patch: { tags: ["original", "testtag"] } }]);
    expect(body.results[0]).toMatchObject({ ok: true, confirmed: { tags: ["original", "testtag"] } });
  });

  test("a listing Etsy stored differently is reported as Etsy stored it", async () => {
    etsyFetchMock.mockResolvedValue(jsonResponse({ listing_id: 101, tags: ["testtag3"] }));
    const { body } = await save([
      { listingId: 101, patch: { tags: ["original", "testtag", "testtag2", "testtag3"] } },
    ]);
    expect(body.results[0].confirmed.tags).toEqual(["testtag3"]);
  });

  test("the cached row takes its title from the response", async () => {
    etsyFetchMock.mockResolvedValue(jsonResponse({ listing_id: 101, title: "Etsy's version" }));
    await save([{ listingId: 101, patch: { title: "Renamed mug" } }]);
    expect(db.listings.find((l) => l.listingId === "101")!.title).toBe("Etsy's version");
  });

  test("a response that isn't a listing leaves the sent patch as the best account", async () => {
    etsyFetchMock.mockResolvedValue(jsonResponse({}));
    const { body } = await save([{ listingId: 101, patch: { title: "Renamed mug" } }]);
    expect(body.results[0].ok).toBe(true);
    expect(body.results[0].confirmed).toBeUndefined();
    expect(db.listings.find((l) => l.listingId === "101")!.title).toBe("Renamed mug");
  });
});

describe("attributes go to Etsy's own property endpoint", () => {
  test("one PUT per property, carrying value ids and names together", async () => {
    const { body } = await save([
      {
        listingId: 101,
        patch: {
          attributes: [
            { propertyId: 200, valueIds: [1], values: ["Red"] },
            { propertyId: 100, valueIds: [7], values: ["M"], scaleId: 19 },
          ],
        },
      },
    ]);
    expect(body.saved).toBe(1);

    const puts = etsyFetchMock.mock.calls.filter(
      ([path, init]) => init?.method === "PUT" && String(path).includes("/properties/"),
    );
    expect(puts).toHaveLength(2);
    expect(puts[0][0]).toBe(`/shops/${SHOP_A}/listings/101/properties/200`);

    const colour = new URLSearchParams(puts[0][1]!.body as string);
    expect(colour.getAll("value_ids")).toEqual(["1"]);
    expect(colour.getAll("values")).toEqual(["Red"]);

    const size = new URLSearchParams(puts[1][1]!.body as string);
    expect(size.get("scale_id")).toBe("19");
  });
});

describe("personalization goes to its own resource", () => {
  test("sent as a full replace, with the multi-question flag Etsy requires", async () => {
    const { body } = await save([
      {
        listingId: 101,
        patch: {
          personalization: [
            { fieldType: "text_input", questionText: "Name?", required: true, maxAllowedCharacters: 50 },
          ],
        },
      },
    ]);
    expect(body.saved).toBe(1);

    const [path, init] = etsyFetchMock.mock.calls.find(([p]) =>
      String(p).includes("/personalization"),
    )!;
    expect(path).toBe(
      `/shops/${SHOP_A}/listings/101/personalization?supports_multiple_personalization_questions=true`,
    );
    const sent = JSON.parse(init!.body as string);
    expect(sent.personalization_questions[0]).toMatchObject({
      question_text: "Name?",
      question_type: "text_input",
      required: true,
    });
  });
});

describe("a variation grid replaces the inventory", () => {
  const variations = {
    products: [
      {
        propertyValues: [{ propertyId: 200, name: "Color", valueIds: [1], values: ["Red"] }],
        price: 10,
        quantity: 2,
        sku: "R",
        enabled: true,
      },
      {
        propertyValues: [{ propertyId: 200, name: "Color", valueIds: [2], values: ["Blue"] }],
        price: 12,
        quantity: 1,
        sku: "B",
        enabled: false,
      },
    ],
    priceOnProperty: [200],
  };

  test("every combination is sent, disabled ones included", async () => {
    const { body } = await save([{ listingId: 101, patch: { variations } }]);
    expect(body.saved).toBe(1);

    const put = etsyFetchMock.mock.calls.find(
      ([path, init]) => init?.method === "PUT" && String(path).includes("/inventory"),
    )!;
    expect(put[0]).toBe("/listings/101/inventory?max_variations_supported=3");
    const sent = JSON.parse(put[1]!.body as string);
    expect(sent.products).toHaveLength(2);
    expect(sent.products[0].offerings[0]).toMatchObject({ price: 10, quantity: 2, is_enabled: true });
    expect(sent.products[1].offerings[0]).toMatchObject({ is_enabled: false });
    expect(sent.price_on_property).toEqual([200]);
  });

  test("the single-product write is skipped, so the grid isn't flattened straight after", async () => {
    await save([{ listingId: 101, patch: { variations, price: 99 } }]);
    // The simple path would have to read the inventory first; the grid path never does.
    expect(etsyCalls()).not.toContain("GET /listings/101/inventory");
    const puts = etsyFetchMock.mock.calls.filter(
      ([path, init]) => init?.method === "PUT" && String(path).includes("/inventory"),
    );
    expect(puts).toHaveLength(1);
  });
});

describe("variation photos are sent after the inventory", () => {
  const grid = {
    products: [
      { propertyValues: [{ propertyId: 200, name: "Color", valueIds: [1], values: ["Red"] }], price: 10, quantity: 2, enabled: true },
      { propertyValues: [{ propertyId: 200, name: "Color", valueIds: [null], values: ["Sunset"] }], price: 12, quantity: 1, enabled: true },
    ],
    priceOnProperty: [200],
  };
  /** What Etsy answers the grid PUT with: the replace gave both values new ids. */
  const REPLACED = {
    products: [
      { property_values: [{ property_id: 200, value_ids: [7001], values: ["Red"] }] },
      { property_values: [{ property_id: 200, value_ids: [7002], values: ["Sunset"] }] },
    ],
  };
  const IMAGES = { results: [{ listing_image_id: 900 }, { listing_image_id: 901 }] };

  /** Routes Etsy calls; `failImages` makes the variation-images POST fail. */
  function etsy({ failInventory = false, failImages = false } = {}) {
    etsyFetchMock.mockImplementation(async (path: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "PUT" && path.includes("/inventory")) {
        return failInventory ? jsonResponse({ error: "Inventory refused." }, 400) : jsonResponse(REPLACED);
      }
      if (method === "GET" && path === "/listings/101/inventory") return jsonResponse(VARIATION_INVENTORY);
      if (method === "GET" && path === "/listings/101/images") return jsonResponse(IMAGES);
      if (method === "POST" && path.endsWith("/variation-images")) {
        return failImages ? jsonResponse({ error: "Etsy refused the variation images." }, 400) : jsonResponse({});
      }
      return jsonResponse({});
    });
  }
  const imagesPost = () =>
    etsyFetchMock.mock.calls.find(([path, init]) => init?.method === "POST" && String(path).endsWith("/variation-images"));

  test("the images call comes after the inventory PUT, with value ids re-read from its response", async () => {
    etsy();
    const { body } = await save([
      {
        listingId: 101,
        patch: {
          title: "Colors",
          variations: grid,
          variationImages: [
            { propertyId: 200, valueId: 1, value: "Red", imageId: 900 },
            { propertyId: 200, valueId: null, value: "Sunset", imageId: 901 },
          ],
        },
      },
    ]);
    expect(body).toMatchObject({ saved: 1, partial: 0, failed: 0 });

    const writes = etsyWrites();
    expect(writes.indexOf("PUT /listings/101/inventory?max_variations_supported=3")).toBeLessThan(
      writes.indexOf(`POST /shops/${SHOP_A}/listings/101/variation-images`),
    );
    // The PUT's own response is the inventory used — no second read.
    expect(etsyCalls()).not.toContain("GET /listings/101/inventory");
    expect(JSON.parse(imagesPost()![1]!.body as string)).toEqual({
      variation_images: [
        { property_id: 200, value_id: 7001, image_id: 900 },
        { property_id: 200, value_id: 7002, image_id: 901 },
      ],
    });
  });

  test("without a grid change the current inventory is read for the ids", async () => {
    etsy();
    await save([{ listingId: 101, patch: { variationImages: [{ propertyId: 200, valueId: 2, value: "Blue", imageId: 900 }] } }]);
    const calls = etsyCalls();
    expect(calls.indexOf("GET /listings/101/inventory")).toBeLessThan(
      calls.indexOf(`POST /shops/${SHOP_A}/listings/101/variation-images`),
    );
    expect(JSON.parse(imagesPost()![1]!.body as string)).toEqual({
      variation_images: [{ property_id: 200, value_id: 2, image_id: 900 }],
    });
  });

  test("a cleared set is sent as an empty list, not skipped", async () => {
    etsy();
    const { body } = await save([{ listingId: 101, patch: { variationImages: [] } }]);
    expect(body.saved).toBe(1);
    expect(JSON.parse(imagesPost()![1]!.body as string)).toEqual({ variation_images: [] });
  });

  test("assignments on two properties are refused without calling Etsy, and the grid still counts as saved", async () => {
    etsy();
    const { body } = await save([
      {
        listingId: 101,
        patch: {
          variations: grid,
          variationImages: [
            { propertyId: 200, valueId: 1, value: "Red", imageId: 900 },
            { propertyId: 100, valueId: 11, value: "S", imageId: 901 },
          ],
        },
      },
    ]);
    expect(imagesPost()).toBeUndefined();
    expect(body.results).toEqual([
      { listingId: 101, ok: false, partial: true, error: "Variation photos: Photos can vary by one variation only." },
    ]);
  });

  test("a failed images call reports the listing as partly saved and rolls nothing back", async () => {
    etsy({ failImages: true });
    const { body } = await save([
      {
        listingId: 101,
        patch: {
          title: "Kept title",
          variations: grid,
          variationImages: [{ propertyId: 200, valueId: 1, value: "Red", imageId: 900 }],
        },
      },
    ]);
    expect(body).toMatchObject({ saved: 0, partial: 1, failed: 0 });
    expect(body.results).toEqual([
      { listingId: 101, ok: false, partial: true, error: "Variation photos: Etsy refused the variation images." },
    ]);
    // Only the grid PUT and the images POST touch the inventory — no undo write.
    expect(etsyWrites().filter((w) => w.includes("/inventory"))).toHaveLength(1);
    expect(db.listings.find((l) => l.listingId === "101")!.title).toBe("Kept title");
  });

  test("a failed inventory update never sends the images", async () => {
    etsy({ failInventory: true });
    const { body } = await save([
      { listingId: 101, patch: { variations: grid, variationImages: [{ propertyId: 200, valueId: 1, value: "Red", imageId: 900 }] } },
    ]);
    expect(imagesPost()).toBeUndefined();
    expect(body.results).toEqual([{ listingId: 101, ok: false, error: "Inventory refused." }]);
  });

  test("a malformed assignment fails validation before anything reaches Etsy", async () => {
    const { status } = await save([{ listingId: 101, patch: { variationImages: [{ propertyId: 200, value: "Red" }] } }]);
    expect(status).toBe(400);
    expect(etsyFetchMock).not.toHaveBeenCalled();
  });

  test("the inventory read returns each variation listing's current photos", async () => {
    etsyFetchMock.mockImplementation(async (path: string) => {
      if (path === "/listings/101/inventory") return jsonResponse(VARIATION_INVENTORY);
      if (path === `/shops/${SHOP_A}/listings/101/variation-images`) {
        return jsonResponse({ results: [{ property_id: 200, value_id: 2, value: "Blue", image_id: 900 }] });
      }
      return jsonResponse({});
    });
    const { body } = await loadInventory("101");
    expect(body.variationImages).toEqual({ 101: [{ propertyId: 200, valueId: 2, value: "Blue", imageId: 900 }] });
    expect(etsyWrites()).toEqual([]);
  });
});

describe("the on-demand reads are scoped like every other bulk route", () => {
  test("attributes are read only for the caller's own listings", async () => {
    const { status, body } = await loadAttributes("101");
    expect(status).toBe(200);
    expect(Object.keys(body.attributes)).toEqual(["101"]);
    expect(etsyWrites()).toEqual([]);
  });

  test("another user's listing yields no attributes and no Etsy call", async () => {
    signInAs("bob", SHOP_A);
    const { body } = await loadAttributes("101");
    expect(body.attributes).toEqual({});
    expect(body.missing).toEqual([101]);
    expect(etsyFetchMock).not.toHaveBeenCalled();
  });

  test("another user's listing yields no inventory and no Etsy call", async () => {
    signInAs("bob", SHOP_A);
    const { body } = await loadInventory("101");
    expect(body.inventories).toEqual({});
    expect(body.missing).toEqual([101]);
    expect(etsyFetchMock).not.toHaveBeenCalled();
  });

  test("both refuse a signed-out caller", async () => {
    authMock.mockResolvedValue(null);
    expect((await loadAttributes("101")).status).toBe(401);
    expect((await loadInventory("101")).status).toBe(401);
    expect(etsyFetchMock).not.toHaveBeenCalled();
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
