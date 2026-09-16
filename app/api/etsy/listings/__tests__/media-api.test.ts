import { beforeEach, describe, expect, test, vi } from "vitest";

/**
 * `POST /api/etsy/listings/[id]/media` — the bulk screen's per-listing photo
 * and video save — over the real planner/executor and a recording
 * `etsyFetch`, with an in-memory `listings` table for the ownership check.
 * Each listing's Etsy state lives in `etsy`, and the fake Etsy applies the
 * image/video calls to it, so assertions read the listing as Etsy would.
 */

const { authMock, shopMock, etsyFetchMock } = vi.hoisted(() => ({
  authMock: vi.fn(),
  shopMock: vi.fn(),
  etsyFetchMock: vi.fn(),
}));

vi.mock("@/auth", () => ({ auth: authMock }));
vi.mock("@/lib/etsy/auth", () => ({ etsyFetch: etsyFetchMock }));
vi.mock("@/lib/db/prisma", () => ({
  get prisma() {
    return fakePrisma;
  },
}));

interface ListingRow {
  userId: string;
  shopId: string;
  listingId: string;
  removedAt: Date | null;
}

const db = { listings: [] as ListingRow[] };

const fakePrisma = {
  listing: {
    async findMany({ where }: { where: Record<string, unknown> }) {
      const ids = (where.listingId as { in?: string[] }).in ?? [];
      return db.listings
        .filter((r) => r.userId === where.userId && r.shopId === where.shopId && ids.includes(r.listingId))
        .map((r) => ({
          ...r,
          title: "",
          state: "active",
          url: "",
          quantity: 1,
          price: null,
          thumbnailUrl: null,
          endingAt: null,
          shopSectionId: null,
          sku: null,
        }));
    },
  },
};

import { POST as SAVE_MEDIA } from "@/app/api/etsy/listings/[id]/media/route";

const SHOP = "12345678";

interface FakeImage {
  listing_image_id: number;
  rank: number;
  alt_text: string;
  url_570xN: string;
}
interface FakeVideo {
  video_id: number;
  video_url: string;
  thumbnail_url: string;
}

/** Etsy's side: each listing's attached images and videos. */
let etsy: Record<number, { images: FakeImage[]; videos: FakeVideo[] }>;
let nextUploadId = 9000;

function response(body: unknown, status = 200) {
  return {
    ok: status < 400,
    status,
    text: async () => (body === null ? "" : JSON.stringify(body)),
    headers: new Headers(),
  } as unknown as Response;
}

const image = (id: number, rank: number, alt = ""): FakeImage => ({
  listing_image_id: id,
  rank,
  alt_text: alt,
  url_570xN: `https://img/${id}.jpg`,
});
const video = (id: number): FakeVideo => ({
  video_id: id,
  video_url: `https://vid/${id}.mp4`,
  thumbnail_url: `https://vid/${id}.jpg`,
});

/** A faithful-enough Etsy for the calls this route makes. */
function fakeEtsy(path: string, init?: RequestInit) {
  const method = init?.method ?? "GET";
  if (method === "GET" && path.startsWith("/listings/batch")) {
    const ids = new URLSearchParams(path.split("?")[1]).get("listing_ids")!.split(",").map(Number);
    return response({
      results: ids
        .filter((id) => etsy[id])
        .map((id) => ({
          listing_id: id,
          images: [...etsy[id].images].sort((a, b) => a.rank - b.rank),
          videos: etsy[id].videos,
        })),
    });
  }
  const imageDelete = /^\/shops\/\d+\/listings\/(\d+)\/images\/(\d+)$/.exec(path);
  if (method === "DELETE" && imageDelete) {
    const listing = etsy[Number(imageDelete[1])];
    const gone = listing.images.find((i) => i.listing_image_id === Number(imageDelete[2]))!;
    listing.images = listing.images
      .filter((i) => i !== gone)
      .map((i) => (i.rank > gone.rank ? { ...i, rank: i.rank - 1 } : i));
    return response(null, 204);
  }
  const imagePost = /^\/shops\/\d+\/listings\/(\d+)\/images$/.exec(path);
  if (method === "POST" && imagePost) {
    const listing = etsy[Number(imagePost[1])];
    const form = init!.body as FormData;
    const id = form.get("listing_image_id") ? Number(form.get("listing_image_id")) : nextUploadId++;
    const placed = image(id, Number(form.get("rank")), String(form.get("alt_text") ?? ""));
    listing.images.push(placed);
    return response(placed, 201);
  }
  const videoDelete = /^\/shops\/\d+\/listings\/(\d+)\/videos\/(\d+)$/.exec(path);
  if (method === "DELETE" && videoDelete) {
    const listing = etsy[Number(videoDelete[1])];
    listing.videos = listing.videos.filter((v) => v.video_id !== Number(videoDelete[2]));
    return response(null, 204);
  }
  const videoPost = /^\/shops\/\d+\/listings\/(\d+)\/videos$/.exec(path);
  if (method === "POST" && videoPost) {
    const listing = etsy[Number(videoPost[1])];
    const form = init!.body as FormData;
    const placed = video(form.get("video_id") ? Number(form.get("video_id")) : nextUploadId++);
    listing.videos.push(placed);
    return response(placed, 201);
  }
  throw new Error(`unexpected Etsy call: ${method} ${path}`);
}

function etsyWrites(): string[] {
  return etsyFetchMock.mock.calls
    .map(([path, init]) => `${(init as RequestInit | undefined)?.method ?? "GET"} ${path}`)
    .filter((c) => !c.startsWith("GET "));
}

/** The listing's images as Etsy now shows them: `id:alt` in rank order. */
const onEtsy = (listingId: number) =>
  [...etsy[listingId].images].sort((a, b) => a.rank - b.rank).map((i) => `${i.listing_image_id}:${i.alt_text}`);

async function saveMedia(
  listingId: number,
  payload: unknown,
  files: { images?: File[]; videos?: File[] } = {},
) {
  const form = new FormData();
  form.set("payload", JSON.stringify(payload));
  for (const f of files.images ?? []) form.append("image", f);
  for (const f of files.videos ?? []) form.append("video", f);
  const res = await SAVE_MEDIA(
    new Request(`http://localhost/api/etsy/listings/${listingId}/media`, { method: "POST", body: form }),
    { params: Promise.resolve({ id: String(listingId) }) },
  );
  return { status: res.status, body: await res.json() };
}

const existing = (imageId: number, altText = "") => ({ kind: "existing", imageId, altText });

beforeEach(async () => {
  authMock.mockReset();
  shopMock.mockReset();
  etsyFetchMock.mockReset();
  etsyFetchMock.mockImplementation(fakeEtsy);
  nextUploadId = 9000;
  const store = await import("@/lib/etsy/listing-store");
  vi.spyOn(store, "resolveActiveShopId").mockImplementation((userId: string) => shopMock(userId));
  authMock.mockResolvedValue({ user: { id: "alice" } });
  shopMock.mockResolvedValue(SHOP);

  db.listings = [
    { userId: "alice", shopId: SHOP, listingId: "101", removedAt: null },
    { userId: "alice", shopId: SHOP, listingId: "102", removedAt: null },
    { userId: "bob", shopId: SHOP, listingId: "999", removedAt: null },
  ];
  etsy = {
    101: { images: [image(1, 1, "front"), image(2, 2), image(3, 3), image(4, 4)], videos: [video(71), video(72)] },
    102: { images: [image(21, 1), image(22, 2), image(23, 3)], videos: [] },
    999: { images: [image(91, 1)], videos: [] },
  };
});

describe("reorder persists on save", () => {
  test("the saved order becomes Etsy's rank order, keeping the untouched leading photos in place", async () => {
    const { status, body } = await saveMedia(101, {
      images: [existing(1, "front"), existing(4), existing(2), existing(3)],
    });
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(onEtsy(101)).toEqual(["1:front", "4:", "2:", "3:"]);
    // Photo 1 was already first with the same alt text, so it was never touched.
    expect(etsyWrites().some((w) => w.endsWith("/images/1"))).toBe(false);
    expect(body.images.map((i: { imageId: number }) => i.imageId)).toEqual([1, 4, 2, 3]);
  });

  test("a new thumbnail moves to rank 1", async () => {
    await saveMedia(101, { images: [existing(3), existing(1, "front"), existing(2), existing(4)] });
    expect(onEtsy(101)).toEqual(["3:", "1:front", "2:", "4:"]);
  });

  test("an unchanged grid makes no Etsy write at all", async () => {
    const { body } = await saveMedia(101, {
      images: [existing(1, "front"), existing(2), existing(3), existing(4)],
      videos: [{ kind: "existing", videoId: 71 }, { kind: "existing", videoId: 72 }],
    });
    expect(body.ok).toBe(true);
    expect(etsyWrites()).toEqual([]);
  });
});

describe("alt text saves to the right image of the right listing", () => {
  test("only the edited image carries the new alt text", async () => {
    await saveMedia(102, { images: [existing(21), existing(22, "Mug on a desk"), existing(23)] });
    expect(onEtsy(102)).toEqual(["21:", "22:Mug on a desk", "23:"]);
    expect(onEtsy(101)).toEqual(["1:front", "2:", "3:", "4:"]);
    expect(etsyWrites().every((w) => w.includes("/listings/102/"))).toBe(true);
  });

  test("clearing alt text is saved too", async () => {
    await saveMedia(101, { images: [existing(1, ""), existing(2), existing(3), existing(4)] });
    expect(onEtsy(101)).toEqual(["1:", "2:", "3:", "4:"]);
  });

  test("new photos upload with their own alt text at their grid position", async () => {
    const file = new File(["x"], "added.jpg", { type: "image/jpeg" });
    await saveMedia(
      102,
      { images: [existing(21), { kind: "new", index: 0, altText: "Close-up" }, existing(22), existing(23)] },
      { images: [file] },
    );
    expect(onEtsy(102)).toEqual(["21:", "9000:Close-up", "22:", "23:"]);
  });
});

describe("remove clears the right tile", () => {
  test("a removed photo is deleted and the rest keep their order", async () => {
    const { body } = await saveMedia(101, { images: [existing(1, "front"), existing(2), existing(4)] });
    expect(body.ok).toBe(true);
    expect(onEtsy(101)).toEqual(["1:front", "2:", "4:"]);
    expect(etsyWrites()).toContain(`DELETE /shops/${SHOP}/listings/101/images/3`);
  });

  test("a removed video is deleted, and videos can be reordered", async () => {
    await saveMedia(101, {
      images: [existing(1, "front"), existing(2), existing(3), existing(4)],
      videos: [{ kind: "existing", videoId: 72 }],
    });
    expect(etsy[101].videos.map((v) => v.video_id)).toEqual([72]);

    etsy[101].videos = [video(71), video(72)];
    etsyFetchMock.mockClear();
    await saveMedia(101, {
      images: [existing(1, "front"), existing(2), existing(3), existing(4)],
      videos: [{ kind: "existing", videoId: 72 }, { kind: "existing", videoId: 71 }],
    });
    expect(etsy[101].videos.map((v) => v.video_id)).toEqual([72, 71]);
  });

  test("a listing is never emptied of photos", async () => {
    const { status } = await saveMedia(101, { images: [] });
    expect(status).toBe(400);
    expect(etsyWrites()).toEqual([]);
  });
});

describe("isolation", () => {
  test("another user's listing is not found and never reaches Etsy", async () => {
    const { status } = await saveMedia(999, { images: [existing(91, "mine now")] });
    expect(status).toBe(404);
    expect(etsyFetchMock).not.toHaveBeenCalled();
  });

  test("an image id from a different listing is refused, not moved across", async () => {
    const { body } = await saveMedia(102, { images: [existing(21), existing(1), existing(22), existing(23)] });
    expect(body.ok).toBe(false);
    expect(onEtsy(102)).toEqual(["21:", "22:", "23:"]);
    expect(onEtsy(101)).toEqual(["1:front", "2:", "3:", "4:"]);
    expect(etsyWrites().some((w) => w.includes("/listings/101/"))).toBe(false);
  });

  test("a bad file is refused before anything is sent", async () => {
    const { status } = await saveMedia(
      101,
      { images: [existing(1, "front"), { kind: "new", index: 0, altText: "" }] },
      { images: [new File(["x"], "notes.txt", { type: "text/plain" })] },
    );
    expect(status).toBe(400);
    expect(etsyFetchMock).not.toHaveBeenCalled();
  });
});
