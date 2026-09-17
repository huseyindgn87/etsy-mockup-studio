import { beforeEach, describe, expect, test, vi } from "vitest";

const { etsy, r2State, storage } = vi.hoisted(() => ({
  etsy: {
    applyBulkUpdates: vi.fn(),
    listings: new Map<number, { images: { imageId: number; altText: string }[]; videos: { videoId: number }[] }>(),
    owned: new Set<number>(),
    assigned: [] as { listingImageId: number; rank: number }[],
    deleted: [] as number[],
    uploaded: [] as { filename: string; bytes: number }[],
    cached: [] as { listingId: number; patch: unknown }[],
  },
  r2State: { configured: true },
  storage: new Map<string, Uint8Array>(),
}));

vi.mock("../publisher", () => ({
  withShopAccessToken: async (_userId: string, _shopId: string, fn: () => Promise<unknown>) => fn(),
}));
vi.mock("@/lib/etsy/bulk-apply", () => ({ applyBulkUpdates: etsy.applyBulkUpdates }));
vi.mock("@/lib/etsy/listing-store", () => ({
  listStoredListingsByIds: async (_u: string, _s: string, ids: number[]) =>
    ids.filter((id) => etsy.owned.has(id)).map((listingId) => ({ listingId })),
  applyStoredListingPatch: async (_u: string, _s: string, listingId: number, patch: unknown) => {
    etsy.cached.push({ listingId, patch });
  },
}));
vi.mock("@/lib/etsy/listing-details", () => ({
  fetchListingDetails: async (ids: number[]) => ids.map((id) => etsy.listings.get(id)).filter(Boolean),
}));
vi.mock("@/lib/etsy/listing-images", () => ({
  uploadListingImage: async ({ filename, bytes, rank }: { filename: string; bytes: Uint8Array; rank: number }) => {
    etsy.uploaded.push({ filename, bytes: bytes.length });
    return { listingImageId: 500 + rank, rank, url: null };
  },
  assignListingImage: async ({ listingImageId, rank }: { listingImageId: number; rank: number }) => {
    etsy.assigned.push({ listingImageId, rank });
    return { listingImageId, rank, url: null };
  },
  deleteListingImage: async ({ listingImageId }: { listingImageId: number }) => {
    etsy.deleted.push(listingImageId);
  },
}));
vi.mock("@/lib/etsy/listing-video", () => ({
  uploadListingVideo: vi.fn(async () => {}),
  assignListingVideo: vi.fn(async () => {}),
  deleteListingVideo: vi.fn(async () => {}),
}));
vi.mock("@/lib/storage/r2", () => ({
  isR2Configured: () => r2State.configured,
  getObject: async (key: string) => {
    const body = storage.get(key);
    return body ? { body } : null;
  },
}));

import type { ScheduledListing } from "@prisma/client";
import type { ScheduledBulkUpdate } from "../bulk-job";
import { applyScheduledBulkEdit, MEDIA_STORAGE_UNAVAILABLE } from "../bulk-publisher";
import { bulkMediaKey } from "../render-keys";
import { SET_A } from "./fixtures";

const ROW = { userId: "alice", shopId: "111", renderSetId: SET_A } as ScheduledListing;
const KEY = bulkMediaKey("alice", SET_A, 101, "image", 0);

/** A listing whose photo grid gains one uploaded file after its existing photo. */
const withNewPhoto = (listingId: number, patch: Record<string, unknown> = { title: "New title" }): ScheduledBulkUpdate =>
  ({
    listingId,
    title: `Listing ${listingId}`,
    patch,
    media: {
      images: [
        { kind: "existing", imageId: 1, altText: "Front" },
        { kind: "new", index: 0, altText: "Back" },
      ],
      videos: [],
      imageFiles: [{ key: bulkMediaKey("alice", SET_A, listingId, "image", 0), filename: "back.jpg", contentType: "image/jpeg" }],
      videoFiles: [],
    },
  }) as ScheduledBulkUpdate;

const fields = (listingId: number, patch: Record<string, unknown> = { title: "New title" }): ScheduledBulkUpdate =>
  ({ listingId, title: `Listing ${listingId}`, patch }) as ScheduledBulkUpdate;

beforeEach(() => {
  vi.clearAllMocks();
  r2State.configured = true;
  storage.clear();
  storage.set(KEY, new Uint8Array([1, 2, 3]));
  etsy.listings = new Map([
    [101, { images: [{ imageId: 1, altText: "Front" }], videos: [] }],
    [102, { images: [{ imageId: 2, altText: "" }], videos: [] }],
  ]);
  etsy.owned = new Set([101, 102]);
  etsy.assigned = [];
  etsy.deleted = [];
  etsy.uploaded = [];
  etsy.cached = [];
  etsy.applyBulkUpdates.mockImplementation(async (_shopId: number, updates: { listingId: number }[]) =>
    updates.map((u) => ({ listingId: u.listingId, ok: true })),
  );
});

describe("applying a scheduled bulk edit", () => {
  test("writes each listing's media and then its fields, and mirrors the cache", async () => {
    const results = await applyScheduledBulkEdit(ROW, [withNewPhoto(101)]);

    expect(results).toEqual([{ listingId: 101, title: "Listing 101", ok: true }]);
    expect(etsy.uploaded).toEqual([{ filename: "back.jpg", bytes: 3 }]);
    expect(etsy.applyBulkUpdates).toHaveBeenCalledWith(111, [{ listingId: 101, patch: { title: "New title" } }]);
    expect(etsy.cached).toEqual([{ listingId: 101, patch: { title: "New title" } }]);
  });

  test("one listing failing never stops the others", async () => {
    etsy.applyBulkUpdates.mockImplementation(async (_shopId: number, updates: { listingId: number }[]) =>
      updates.map((u) =>
        u.listingId === 101 ? { listingId: u.listingId, ok: false, error: "Etsy said no" } : { listingId: u.listingId, ok: true },
      ),
    );

    const results = await applyScheduledBulkEdit(ROW, [fields(101), fields(102, { quantity: 4 })]);

    expect(results).toEqual([
      { listingId: 101, title: "Listing 101", ok: false, error: "Etsy said no" },
      { listingId: 102, title: "Listing 102", ok: true },
    ]);
    expect(etsy.cached).toEqual([{ listingId: 102, patch: { quantity: 4 } }]);
  });

  test("a listing that is no longer this shop's is reported, not sent to Etsy", async () => {
    etsy.owned = new Set([102]);

    const results = await applyScheduledBulkEdit(ROW, [fields(101), fields(102)]);

    expect(results[0]).toEqual({ listingId: 101, title: "Listing 101", ok: false, error: "Listing not found." });
    expect(etsy.applyBulkUpdates).toHaveBeenCalledTimes(1);
    expect(etsy.applyBulkUpdates.mock.calls[0][1]).toEqual([{ listingId: 102, patch: { title: "New title" } }]);
  });

  test("only the variation photos failing is reported as partly saved", async () => {
    etsy.applyBulkUpdates.mockResolvedValue([
      { listingId: 101, ok: false, partial: true, error: "Variation photos: no" },
    ]);

    const results = await applyScheduledBulkEdit(ROW, [fields(101)]);

    expect(results).toEqual([
      { listingId: 101, title: "Listing 101", ok: false, partial: true, error: "Variation photos: no" },
    ]);
  });
});

describe("without file storage", () => {
  test("the field edits still apply and the photos say why they didn't", async () => {
    r2State.configured = false;

    const results = await applyScheduledBulkEdit(ROW, [withNewPhoto(101, { title: "New title", quantity: 4 })]);

    expect(results).toEqual([
      { listingId: 101, title: "Listing 101", ok: false, partial: true, error: MEDIA_STORAGE_UNAVAILABLE },
    ]);
    expect(etsy.applyBulkUpdates).toHaveBeenCalledWith(111, [
      { listingId: 101, patch: { title: "New title", quantity: 4 } },
    ]);
    expect(etsy.uploaded).toEqual([]);
    expect(etsy.deleted).toEqual([]);
  });

  test("a reorder that adds no file is saved anyway", async () => {
    r2State.configured = false;
    etsy.listings.set(101, { images: [{ imageId: 1, altText: "" }, { imageId: 2, altText: "" }], videos: [] });

    const results = await applyScheduledBulkEdit(ROW, [
      {
        listingId: 101,
        title: "Listing 101",
        patch: {},
        media: {
          images: [
            { kind: "existing", imageId: 2, altText: "" },
            { kind: "existing", imageId: 1, altText: "" },
          ],
          videos: [],
          imageFiles: [],
          videoFiles: [],
        },
      } as ScheduledBulkUpdate,
    ]);

    expect(results).toEqual([{ listingId: 101, title: "Listing 101", ok: true }]);
    expect(etsy.assigned).toEqual([
      { listingImageId: 2, rank: 1 },
      { listingImageId: 1, rank: 2 },
    ]);
  });

  test("a stored photo that has gone missing fails only that listing's photos", async () => {
    storage.clear();

    const results = await applyScheduledBulkEdit(ROW, [withNewPhoto(101)]);

    expect(results[0].partial).toBe(true);
    expect(results[0].error).toContain("back.jpg is missing from storage");
    expect(etsy.applyBulkUpdates).toHaveBeenCalledTimes(1);
  });
});
