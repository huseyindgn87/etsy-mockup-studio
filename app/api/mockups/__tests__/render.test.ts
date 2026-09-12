import { afterAll, describe, expect, test, vi } from "vitest";
import sharp from "sharp";

vi.mock("@/lib/etsy/auth", () => ({
  getEtsySession: vi.fn(async () => ({
    userId: "1",
    accessToken: "a",
    refreshToken: "r",
    expiresAt: Date.now() + 1_000_000,
  })),
}));

vi.mock("@/lib/etsy/listings", () => ({
  EtsyApiError: class extends Error {
    status: number;
    constructor(msg: string, status = 500) {
      super(msg);
      this.status = status;
    }
  },
  getShopId: vi.fn(async () => 4242),
}));

const uploadCalls: {
  rank?: number;
  contentType: string;
  listingId: number;
  overwrite?: boolean;
}[] = [];
vi.mock("@/lib/etsy/listing-images", () => ({
  uploadListingImage: vi.fn(
    async (p: {
      rank?: number;
      contentType: string;
      listingId: number;
      overwrite?: boolean;
    }) => {
      uploadCalls.push({
        rank: p.rank,
        contentType: p.contentType,
        listingId: p.listingId,
        overwrite: p.overwrite,
      });
      return { listingImageId: 9000 + (p.rank ?? 0), rank: p.rank ?? 1, url: null };
    },
  ),
}));

const createCalls: unknown[] = [];
const propertyCalls: unknown[] = [];
const skuCalls: unknown[] = [];
const inventoryCalls: unknown[] = [];
const variationImageCalls: unknown[] = [];
const settingsCalls: unknown[] = [];
let propertyShouldFail = false;
let skuShouldFail = false;
let inventoryShouldFail = false;
let settingsShouldFail = false;
vi.mock("@/lib/etsy/listing-create", () => ({
  getListingStructure: vi.fn(async () => ({
    title: "Source tee",
    description: "a shirt",
    quantity: 3,
    price: 24,
    currencyCode: "USD",
    whoMade: "i_did",
    whenMade: "made_to_order",
    taxonomyId: 1234,
    shippingProfileId: 55,
    returnPolicyId: 66,
    readinessStateId: 321,
    tags: ["a", "b"],
    materials: ["cotton"],
  })),
  createDraftListing: vi.fn(async (_shop: number, input: unknown) => {
    createCalls.push(input);
    return 999001;
  }),
  setListingProperty: vi.fn(async (_shop: number, _listing: number, input: unknown) => {
    propertyCalls.push(input);
    if (propertyShouldFail) throw new Error("Etsy rejected the property");
  }),
  setListingInventorySku: vi.fn(async (_listing: number, input: unknown) => {
    skuCalls.push(input);
    if (skuShouldFail) throw new Error("Etsy rejected the SKU");
  }),
  updateListingInventory: vi.fn(async (_listing: number, input: unknown) => {
    inventoryCalls.push(input);
    if (inventoryShouldFail) throw new Error("Etsy rejected the inventory grid");
  }),
  updateListingSettings: vi.fn(async (_shop: number, _listing: number, input: unknown) => {
    settingsCalls.push(input);
    if (settingsShouldFail) throw new Error("Etsy rejected the settings update");
  }),
  updateVariationImages: vi.fn(async (_shop: number, _listing: number, images: unknown) => {
    variationImageCalls.push(images);
  }),
}));

import { getEtsySession } from "@/lib/etsy/auth";
import { POST } from "@/app/api/mockups/render/route";
import { getRenderPool } from "@/lib/mockup/render-pool";

afterAll(async () => {
  await getRenderPool().close();
});

const png = (w: number, h: number, rgb: [number, number, number]) =>
  sharp({
    create: {
      width: w,
      height: h,
      channels: 4,
      background: { r: rgb[0], g: rgb[1], b: rgb[2], alpha: 1 },
    },
  })
    .png()
    .toBuffer();

function zipEntryNames(buf: Uint8Array): { name: string; head: number[] }[] {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const dec = new TextDecoder();
  const out: { name: string; head: number[] }[] = [];
  let o = 0;
  while (o + 4 <= buf.length && dv.getUint32(o, true) === 0x04034b50) {
    const compSize = dv.getUint32(o + 18, true);
    const nameLen = dv.getUint16(o + 26, true);
    const extraLen = dv.getUint16(o + 28, true);
    const name = dec.decode(buf.subarray(o + 30, o + 30 + nameLen));
    const dataStart = o + 30 + nameLen + extraLen;
    out.push({ name, head: [...buf.subarray(dataStart, dataStart + 3)] });
    o = dataStart + compSize;
  }
  return out;
}

function form(payload: unknown, files: { field: string; buf: Buffer; name: string }[]) {
  const fd = new FormData();
  for (const f of files) {
    fd.append(f.field, new Blob([new Uint8Array(f.buf)], { type: "image/png" }), f.name);
  }
  fd.append("payload", JSON.stringify(payload));
  return new Request("http://localhost/api/mockups/render", { method: "POST", body: fd });
}

describe("POST /api/mockups/render", () => {
  test("streams a ZIP of the rendered jobs", async () => {
    const mock = await png(160, 120, [100, 110, 120]);
    const design = await png(60, 60, [10, 210, 10]);

    const res = await POST(
      form(
        {
          format: "jpeg",
          targetMB: [0.02, 0.08],
          namePattern: "{design}_{mockup}",
          mockups: [
            {
              name: "shirt",
              width: 160,
              height: 120,
              calibration: {
                qs: [
                  [
                    [0.2, 0.2],
                    [0.8, 0.2],
                    [0.8, 0.8],
                    [0.2, 0.8],
                  ],
                ],
                shade: 15,
              },
            },
          ],
          designs: [{ name: "logo" }],
          jobs: [{ mockup: 0, design: 0 }, { mockup: 0, design: 0 }],
        },
        [
          { field: "mockup", buf: mock, name: "m0.png" },
          { field: "design", buf: design, name: "d0.png" },
        ],
      ),
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/zip");
    expect(res.headers.get("content-disposition")).toContain("mockups.zip");

    const buf = new Uint8Array(await res.arrayBuffer());
    const entries = zipEntryNames(buf);
    expect(entries.map((e) => e.name)).toEqual(["logo_shirt.jpg", "logo_shirt-2.jpg"]);
    for (const e of entries) expect(e.head).toEqual([0xff, 0xd8, 0xff]);

    // EOCD present, 2 entries
    const dv = new DataView(buf.buffer);
    const eocd = buf.length - 22;
    expect(dv.getUint32(eocd, true)).toBe(0x06054b50);
    expect(dv.getUint16(eocd + 10, true)).toBe(2);
  }, 30_000);

  test("401 when not connected", async () => {
    vi.mocked(getEtsySession).mockResolvedValueOnce(null);
    const res = await POST(
      form({ mockups: [], designs: [], jobs: [] }, []),
    );
    expect(res.status).toBe(401);
  });

  test("400 on an out-of-range job index", async () => {
    const mock = await png(20, 20, [0, 0, 0]);
    const res = await POST(
      form(
        { mockups: [{ name: "m", calibration: {} }], designs: [], jobs: [{ mockup: 5 }] },
        [{ field: "mockup", buf: mock, name: "m.png" }],
      ),
    );
    expect(res.status).toBe(400);
  });

  test("400 when payload.mockups count disagrees with the files", async () => {
    const mock = await png(20, 20, [0, 0, 0]);
    const res = await POST(
      form(
        { mockups: [], designs: [], jobs: [{ mockup: 0 }] },
        [{ field: "mockup", buf: mock, name: "m.png" }],
      ),
    );
    expect(res.status).toBe(400);
  });

  test("publishTo uploads the renders to an Etsy listing at sequential ranks", async () => {
    uploadCalls.length = 0;
    const mock = await png(120, 100, [90, 100, 110]);
    const design = await png(50, 50, [10, 200, 10]);

    const res = await POST(
      form(
        {
          format: "jpeg",
          publishTo: { listingId: 777, startRank: 1 },
          mockups: [
            { name: "tee", width: 120, height: 100, calibration: { shade: 10 } },
          ],
          designs: [{ name: "a" }, { name: "b" }],
          jobs: [
            { mockup: 0, design: 0 },
            { mockup: 0, design: 1 },
          ],
        },
        [
          { field: "mockup", buf: mock, name: "m.png" },
          { field: "design", buf: design, name: "a.png" },
          { field: "design", buf: design, name: "b.png" },
        ],
      ),
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = (await res.json()) as {
      listingId: number;
      shopId: number;
      uploaded: { rank: number }[];
      failed: unknown[];
      skipped: number;
    };
    expect(body.listingId).toBe(777);
    expect(body.shopId).toBe(4242);
    expect(body.uploaded).toHaveLength(2);
    expect(body.failed).toHaveLength(0);
    expect(body.skipped).toBe(0);
    expect(uploadCalls.map((c) => c.rank)).toEqual([1, 2]);
    expect(uploadCalls.every((c) => c.listingId === 777)).toBe(true);
    expect(uploadCalls.every((c) => c.contentType === "image/jpeg")).toBe(true);
    // never replaces images unless explicitly asked
    expect(uploadCalls.every((c) => c.overwrite === false)).toBe(true);
  }, 30_000);

  test("mode:copy creates a draft seeded from the source and uploads there", async () => {
    uploadCalls.length = 0;
    createCalls.length = 0;
    const mock = await png(120, 100, [90, 100, 110]);
    const design = await png(50, 50, [10, 200, 10]);

    const res = await POST(
      form(
        {
          publishTo: { mode: "copy", listingId: 500 },
          mockups: [{ name: "tee", width: 120, height: 100, calibration: {} }],
          designs: [{ name: "a" }],
          jobs: [{ mockup: 0, design: 0 }],
        },
        [
          { field: "mockup", buf: mock, name: "m.png" },
          { field: "design", buf: design, name: "a.png" },
        ],
      ),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      mode: string;
      sourceListingId: number;
      listingId: number;
      createdDraft: boolean;
    };
    expect(body.mode).toBe("copy");
    expect(body.sourceListingId).toBe(500);
    expect(body.listingId).toBe(999001);
    expect(body.createdDraft).toBe(true);
    expect(createCalls).toHaveLength(1);
    expect(createCalls[0]).toMatchObject({
      title: "Source tee (copy)",
      taxonomyId: 1234,
      shippingProfileId: 55,
      readinessStateId: 321,
      tags: ["a", "b"],
    });
    // uploaded to the NEW draft, not the source
    expect(uploadCalls.every((c) => c.listingId === 999001)).toBe(true);
  }, 30_000);

  test("mode:new needs a title and borrows only structure from the source", async () => {
    uploadCalls.length = 0;
    createCalls.length = 0;
    const mock = await png(80, 80, [0, 0, 0]);

    const noTitle = await POST(
      form(
        {
          publishTo: { mode: "new", listingId: 500, newListing: {} },
          mockups: [{ name: "m", calibration: {} }],
          designs: [],
          jobs: [{ mockup: 0 }],
        },
        [{ field: "mockup", buf: mock, name: "m.png" }],
      ),
    );
    expect(noTitle.status).toBe(400);

    const ok = await POST(
      form(
        {
          publishTo: {
            mode: "new",
            listingId: 500,
            newListing: { title: "Blank draft", quantity: 7 },
          },
          mockups: [{ name: "m", calibration: {} }],
          designs: [],
          jobs: [{ mockup: 0 }],
        },
        [{ field: "mockup", buf: mock, name: "m.png" }],
      ),
    );
    expect(ok.status).toBe(200);
    expect(createCalls[0]).toMatchObject({
      title: "Blank draft",
      quantity: 7,
      taxonomyId: 1234,
      readinessStateId: 321, // falls back to the source listing's since none was chosen
      tags: [],
      materials: [],
    });
  }, 30_000);

  test("mode:new uses the form's chosen readiness state instead of the source's", async () => {
    createCalls.length = 0;
    const mock = await png(80, 80, [0, 0, 0]);

    const res = await POST(
      form(
        {
          publishTo: {
            mode: "new",
            listingId: 500,
            newListing: { title: "Ready to ship tee", readinessStateId: 654 },
          },
          mockups: [{ name: "m", calibration: {} }],
          designs: [],
          jobs: [{ mockup: 0 }],
        },
        [{ field: "mockup", buf: mock, name: "m.png" }],
      ),
    );

    expect(res.status).toBe(200);
    expect(createCalls[0]).toMatchObject({ readinessStateId: 654 });
  }, 30_000);

  test("mode:new sends featured_rank/should_auto_renew via a follow-up settings call, and reports its failure without failing the publish", async () => {
    settingsCalls.length = 0;
    settingsShouldFail = false;
    const mock = await png(60, 60, [0, 0, 0]);

    const ok = await POST(
      form(
        {
          publishTo: {
            mode: "new",
            listingId: 500,
            newListing: { title: "Featured tee", featuredRank: 1, shouldAutoRenew: false },
          },
          mockups: [{ name: "m", calibration: {} }],
          designs: [],
          jobs: [{ mockup: 0 }],
        },
        [{ field: "mockup", buf: mock, name: "m.png" }],
      ),
    );
    expect(ok.status).toBe(200);
    expect(settingsCalls).toEqual([{ featuredRank: 1, shouldAutoRenew: false }]);

    settingsCalls.length = 0;
    settingsShouldFail = true;
    const res = await POST(
      form(
        {
          publishTo: {
            mode: "new",
            listingId: 500,
            newListing: { title: "Featured tee 2", featuredRank: 1 },
          },
          mockups: [{ name: "m", calibration: {} }],
          designs: [],
          jobs: [{ mockup: 0 }],
        },
        [{ field: "mockup", buf: mock, name: "m.png" }],
      ),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { createdDraft: boolean; failed: { name: string }[] };
    expect(body.createdDraft).toBe(true);
    expect(body.failed.map((f) => f.name)).toEqual(["Settings"]);

    settingsShouldFail = false;
  }, 30_000);

  test("mode:new sends a chosen category, deduped/capped tags, section and properties, then sets the SKU", async () => {
    uploadCalls.length = 0;
    createCalls.length = 0;
    propertyCalls.length = 0;
    skuCalls.length = 0;
    propertyShouldFail = false;
    skuShouldFail = false;
    const mock = await png(80, 80, [0, 0, 0]);

    const tooManyTags = Array.from({ length: 20 }, (_, i) => `tag${i}`);
    tooManyTags[5] = "Duplicate";
    tooManyTags[6] = "duplicate"; // same tag, different case — should collapse to one
    tooManyTags[7] = "a".repeat(40); // longer than 20 chars — should be truncated

    const res = await POST(
      form(
        {
          publishTo: {
            mode: "new",
            listingId: 500,
            newListing: {
              title: "Miami skyline tee",
              description: "A tee",
              tags: tooManyTags,
              taxonomyId: 777,
              shopSectionId: 88,
              price: 19.99,
              quantity: 5,
              sku: "  MIA-001  ",
              properties: [
                { propertyId: 200, name: "Primary color", valueIds: [1], values: ["Black"] },
                { propertyId: 201, name: "Occasion", valueIds: [2, 3], values: ["Birthday", "Wedding"] },
                // malformed: mismatched array lengths — must be dropped, not sent
                { propertyId: 202, name: "Bad", valueIds: [1, 2], values: ["only one"] },
              ],
            },
          },
          mockups: [{ name: "m", calibration: {} }],
          designs: [],
          jobs: [{ mockup: 0 }],
        },
        [{ field: "mockup", buf: mock, name: "m.png" }],
      ),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { createdDraft: boolean; failed: unknown[] };
    expect(body.createdDraft).toBe(true);
    expect(body.failed).toEqual([]);

    expect(createCalls[0]).toMatchObject({ taxonomyId: 777, shopSectionId: 88 });
    const sentTags = (createCalls[0] as { tags: string[] }).tags;
    expect(sentTags).toHaveLength(13); // capped
    expect(sentTags.filter((t) => t.toLowerCase() === "duplicate")).toHaveLength(1);
    expect(sentTags.every((t) => t.length <= 20)).toBe(true);

    expect(propertyCalls).toEqual([
      { propertyId: 200, name: "Primary color", valueIds: [1], values: ["Black"], scaleId: null },
      {
        propertyId: 201,
        name: "Occasion",
        valueIds: [2, 3],
        values: ["Birthday", "Wedding"],
        scaleId: null,
      },
    ]); // the mismatched-length entry never reached setListingProperty

    expect(skuCalls).toEqual([{ sku: "MIA-001", price: 19.99, quantity: 5 }]);
  }, 30_000);

  test("mode:new reports property/SKU failures without failing the whole publish", async () => {
    uploadCalls.length = 0;
    propertyShouldFail = true;
    skuShouldFail = true;
    const mock = await png(60, 60, [0, 0, 0]);

    const res = await POST(
      form(
        {
          publishTo: {
            mode: "new",
            listingId: 500,
            newListing: {
              title: "Retry-safe draft",
              sku: "X-1",
              properties: [{ propertyId: 1, name: "Primary color", valueIds: [1], values: ["Red"] }],
            },
          },
          mockups: [{ name: "m", calibration: {} }],
          designs: [],
          jobs: [{ mockup: 0 }],
        },
        [{ field: "mockup", buf: mock, name: "m.png" }],
      ),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      createdDraft: boolean;
      uploaded: unknown[];
      failed: { name: string; error: string }[];
    };
    expect(body.createdDraft).toBe(true);
    expect(body.uploaded).toHaveLength(1); // image upload still went through
    expect(body.failed.map((f) => f.name).sort()).toEqual(["Primary color", "SKU"]);

    propertyShouldFail = false;
    skuShouldFail = false;
  }, 30_000);

  test("mode:new with a variation grid uses the Inventory API instead of the single-SKU path", async () => {
    uploadCalls.length = 0;
    skuCalls.length = 0;
    inventoryCalls.length = 0;
    variationImageCalls.length = 0;
    inventoryShouldFail = false;
    const mock = await png(60, 60, [0, 0, 0]);

    const res = await POST(
      form(
        {
          publishTo: {
            mode: "new",
            listingId: 500,
            newListing: {
              title: "Tee with variations",
              price: 19.99,
              quantity: 5,
              sku: "SHOULD-NOT-BE-USED",
              variations: {
                priceOnProperty: [200],
                quantityOnProperty: [200],
                skuOnProperty: [200],
                products: [
                  {
                    propertyValues: [
                      { propertyId: 200, name: "Color", valueIds: [1], values: ["Black"] },
                    ],
                    price: 21.5,
                    quantity: 3,
                    sku: "TEE-BLK",
                  },
                  {
                    propertyValues: [
                      { propertyId: 200, name: "Color", valueIds: [2], values: ["Red"] },
                    ],
                    // no price/quantity -> should fall back to the base 19.99 / 5
                  },
                ],
              },
            },
          },
          mockups: [{ name: "m", calibration: {} }],
          designs: [],
          jobs: [{ mockup: 0 }],
        },
        [{ field: "mockup", buf: mock, name: "m.png" }],
      ),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { createdDraft: boolean; failed: unknown[] };
    expect(body.createdDraft).toBe(true);
    expect(body.failed).toEqual([]);

    expect(skuCalls).toEqual([]); // variations replace the single-SKU call entirely
    expect(inventoryCalls).toEqual([
      {
        products: [
          {
            sku: "TEE-BLK",
            propertyValues: [{ propertyId: 200, name: "Color", valueIds: [1], values: ["Black"] }],
            price: 21.5,
            quantity: 3,
            readinessStateId: undefined,
            enabled: true,
          },
          {
            sku: undefined,
            propertyValues: [{ propertyId: 200, name: "Color", valueIds: [2], values: ["Red"] }],
            price: 19.99, // fell back to the base price
            quantity: 5, // fell back to the base quantity
            readinessStateId: undefined,
            enabled: true,
          },
        ],
        priceOnProperty: [200],
        quantityOnProperty: [200],
        skuOnProperty: [200],
        readinessStateOnProperty: [],
      },
    ]);
  }, 30_000);

  test("mode:new keeps a disabled combination in the grid, sent with enabled:false rather than dropped", async () => {
    uploadCalls.length = 0;
    skuCalls.length = 0;
    inventoryCalls.length = 0;
    variationImageCalls.length = 0;
    inventoryShouldFail = false;
    const mock = await png(60, 60, [0, 0, 0]);

    const res = await POST(
      form(
        {
          publishTo: {
            mode: "new",
            listingId: 500,
            newListing: {
              title: "Tee with a discontinued color",
              price: 19.99,
              quantity: 5,
              variations: {
                products: [
                  {
                    propertyValues: [
                      { propertyId: 200, name: "Color", valueIds: [1], values: ["Black"] },
                    ],
                    enabled: true,
                  },
                  {
                    propertyValues: [
                      { propertyId: 200, name: "Color", valueIds: [2], values: ["Red"] },
                    ],
                    enabled: false,
                  },
                ],
              },
            },
          },
          mockups: [{ name: "m", calibration: {} }],
          designs: [],
          jobs: [{ mockup: 0 }],
        },
        [{ field: "mockup", buf: mock, name: "m.png" }],
      ),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { createdDraft: boolean; failed: unknown[] };
    expect(body.createdDraft).toBe(true);
    expect(body.failed).toEqual([]);

    expect(inventoryCalls).toHaveLength(1);
    const products = (inventoryCalls[0] as { products: { enabled: boolean }[] }).products;
    expect(products).toHaveLength(2); // the disabled row is still present, not dropped
    expect(products.map((p) => p.enabled)).toEqual([true, false]);
  }, 30_000);

  test("mode:new resolves imagesByValue job indices to uploaded listing image ids", async () => {
    uploadCalls.length = 0;
    inventoryCalls.length = 0;
    variationImageCalls.length = 0;
    inventoryShouldFail = false;
    const mockA = await png(60, 60, [0, 0, 0]);
    const designRed = await png(10, 10, [255, 0, 0]);
    const designBlue = await png(10, 10, [0, 0, 255]);

    const res = await POST(
      form(
        {
          publishTo: {
            mode: "new",
            listingId: 500,
            newListing: {
              title: "Tee with per-value images",
              price: 10,
              quantity: 1,
              variations: {
                products: [
                  {
                    propertyValues: [
                      { propertyId: 200, name: "Color", valueIds: [1], values: ["Red"] },
                    ],
                  },
                  {
                    propertyValues: [
                      { propertyId: 200, name: "Color", valueIds: [2], values: ["Blue"] },
                    ],
                  },
                ],
                // jobIndex 0 -> first job (design 0/red), jobIndex 1 -> second job (design 1/blue)
                imagesByValue: [
                  { propertyId: 200, valueId: 1, jobIndex: 0 },
                  { propertyId: 200, valueId: 2, jobIndex: 1 },
                ],
              },
            },
          },
          mockups: [{ name: "m", calibration: {} }],
          designs: [{ name: "red" }, { name: "blue" }],
          jobs: [
            { mockup: 0, design: 0 },
            { mockup: 0, design: 1 },
          ],
        },
        [
          { field: "mockup", buf: mockA, name: "m.png" },
          { field: "design", buf: designRed, name: "red.png" },
          { field: "design", buf: designBlue, name: "blue.png" },
        ],
      ),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      failed: unknown[];
      uploaded: { rank: number; listingImageId: number }[];
    };
    expect(body.failed).toEqual([]);
    expect(body.uploaded).toHaveLength(2);

    expect(variationImageCalls).toEqual([
      [
        { propertyId: 200, valueId: 1, imageId: body.uploaded[0].listingImageId },
        { propertyId: 200, valueId: 2, imageId: body.uploaded[1].listingImageId },
      ],
    ]);
  }, 30_000);

  test("mode:new reports an inventory-grid failure without failing the whole publish, and skips the image-assignment call", async () => {
    uploadCalls.length = 0;
    inventoryCalls.length = 0;
    variationImageCalls.length = 0;
    inventoryShouldFail = true;
    const mock = await png(60, 60, [0, 0, 0]);

    const res = await POST(
      form(
        {
          publishTo: {
            mode: "new",
            listingId: 500,
            newListing: {
              title: "Tee, inventory will fail",
              variations: {
                products: [
                  {
                    propertyValues: [
                      { propertyId: 200, name: "Color", valueIds: [1], values: ["Black"] },
                    ],
                  },
                ],
                imagesByValue: [{ propertyId: 200, valueId: 1, jobIndex: 0 }],
              },
            },
          },
          mockups: [{ name: "m", calibration: {} }],
          designs: [],
          jobs: [{ mockup: 0 }],
        },
        [{ field: "mockup", buf: mock, name: "m.png" }],
      ),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      createdDraft: boolean;
      uploaded: unknown[];
      failed: { name: string; error: string }[];
    };
    expect(body.createdDraft).toBe(true);
    expect(body.uploaded).toHaveLength(1); // image upload still went through
    expect(body.failed.map((f) => f.name)).toEqual(["Variations"]);
    expect(variationImageCalls).toEqual([]); // grid never saved -> no point attaching images to it

    inventoryShouldFail = false;
  }, 30_000);

  test("publishTo rejects a bad listingId", async () => {
    const mock = await png(20, 20, [0, 0, 0]);
    const res = await POST(
      form(
        {
          publishTo: { listingId: 0 },
          mockups: [{ name: "m", calibration: {} }],
          designs: [],
          jobs: [{ mockup: 0 }],
        },
        [{ field: "mockup", buf: mock, name: "m.png" }],
      ),
    );
    expect(res.status).toBe(400);
  });
});
