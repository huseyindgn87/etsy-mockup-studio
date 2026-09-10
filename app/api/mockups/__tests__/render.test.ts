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
    tags: ["a", "b"],
    materials: ["cotton"],
  })),
  createDraftListing: vi.fn(async (_shop: number, input: unknown) => {
    createCalls.push(input);
    return 999001;
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
      title: "Source tee (kopya)",
      taxonomyId: 1234,
      shippingProfileId: 55,
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
      tags: [],
      materials: [],
    });
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
