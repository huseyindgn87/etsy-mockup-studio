import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, test, vi } from "vitest";

const { calls, objects, draft } = vi.hoisted(() => ({
  calls: [] as string[],
  objects: new Map<string, Buffer>(),
  /** What the draft holds when the runner reads it; `spec` stands in for the form (draft-spec is mocked). */
  draft: { current: null as { spec: unknown } | null },
}));

vi.mock("@/lib/db/prisma", () => ({
  prisma: {
    listingDraft: {
      findFirst: vi.fn(async () =>
        draft.current
          ? { formData: draft.current.spec, photosData: {}, sourceMode: null, sourceListingId: null }
          : null,
      ),
    },
  },
}));
vi.mock("../draft-spec", () => ({
  publishSpecFromDraft: vi.fn((d: { formData: unknown }, images: unknown) => ({ spec: d.formData, images })),
}));

vi.mock("@/lib/etsy/auth", () => ({
  withEtsyAccessToken: vi.fn(async (_token: string, fn: () => Promise<unknown>) => fn()),
}));
vi.mock("@/lib/etsy/oauth", () => ({
  refreshSession: vi.fn(async () => ({
    accessToken: "fresh-access",
    refreshToken: "rotated-refresh",
    expiresAt: 0,
    userId: "1",
  })),
}));
vi.mock("@/lib/etsy/shop-connections", () => ({
  getDecryptedRefreshToken: vi.fn(async () => "stored-refresh"),
  getCachedAccessToken: vi.fn(async () => null),
  saveConnectionTokens: vi.fn(async () => {}),
}));
vi.mock("@/lib/etsy/listing-create", () => ({
  createDraftListing: vi.fn(async () => {
    calls.push("create");
    return 4242;
  }),
  activateListing: vi.fn(async () => {
    calls.push("activate");
  }),
  getListingStructure: vi.fn(),
  setListingProperty: vi.fn(async () => {
    calls.push("property");
  }),
  setListingInventorySku: vi.fn(async () => {}),
  updateListingInventory: vi.fn(async () => {
    calls.push("inventory");
    return {
      products: [
        { property_values: [{ property_id: 513, value_ids: [9001], values: ["Glossy"] }] },
        { property_values: [{ property_id: 513, value_ids: [9002], values: ["Matte"] }] },
      ],
    };
  }),
  updateVariationImages: vi.fn(async () => {
    calls.push("variation-images");
  }),
  updateListingPersonalization: vi.fn(async () => {}),
  updateListingSettings: vi.fn(async () => {
    calls.push("settings");
  }),
}));
vi.mock("@/lib/etsy/bulk-apply", () => ({
  deleteEtsyListing: vi.fn(async () => {
    calls.push("delete");
  }),
}));
vi.mock("@/lib/etsy/listing-images", () => ({
  uploadListingImage: vi.fn(async (p: { rank: number }) => {
    calls.push(`image:${p.rank}`);
    return { listingImageId: 100 + p.rank, rank: p.rank, url: null };
  }),
}));
vi.mock("@/lib/storage/r2", () => ({
  getObject: vi.fn(async (key: string) =>
    objects.has(key) ? { body: objects.get(key)!, contentType: "image/jpeg" } : null,
  ),
}));

import type { ScheduledListing } from "@prisma/client";
import { withEtsyAccessToken } from "@/lib/etsy/auth";
import { deleteEtsyListing } from "@/lib/etsy/bulk-apply";
import {
  activateListing,
  createDraftListing,
  setListingProperty,
  updateListingInventory,
  updateVariationImages,
} from "@/lib/etsy/listing-create";
import { uploadListingImage } from "@/lib/etsy/listing-images";
import { refreshSession } from "@/lib/etsy/oauth";
import { getCachedAccessToken, getDecryptedRefreshToken, saveConnectionTokens } from "@/lib/etsy/shop-connections";
import { getObject } from "@/lib/storage/r2";
import { publishScheduledListing } from "../publisher";
import { SET_A, storedImages, VALID_SPEC } from "./fixtures";

/** The stored `images` column, typed as Prisma's JSON value. */
const jsonImages = (n: number, userId = "alice") =>
  storedImages(userId, n) as unknown as ScheduledListing["images"];

function makeRow(overrides: Partial<ScheduledListing> = {}): ScheduledListing {
  return {
    id: "s1",
    userId: "alice",
    shopId: "111",
    draftId: "draft-1",
    activeDraftId: "draft-1",
    scheduledAt: new Date("2026-09-17T12:00:00Z"),
    timezone: "UTC",
    status: "publishing",
    publishSpec: VALID_SPEC,
    renderSetId: SET_A,
    images: jsonImages(3),
    attemptCount: 0,
    nextAttemptAt: null,
    lastError: null,
    etsyListingId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as ScheduledListing;
}

function storeImages(n: number) {
  for (const image of storedImages("alice", n)) objects.set(image.key, Buffer.from(`bytes of ${image.key}`));
}

const hooks = () => ({ onListingCreated: vi.fn(async () => {}), onListingDeleted: vi.fn(async () => {}) });

beforeEach(() => {
  vi.clearAllMocks();
  calls.length = 0;
  objects.clear();
  draft.current = { spec: VALID_SPEC };
});

const draftHolds = (spec: unknown) => {
  draft.current = { spec };
};

describe("publishScheduledListing", () => {
  test("creates the listing, attaches 20 stored images in order, then activates it", async () => {
    storeImages(20);
    const h = hooks();
    const listingId = await publishScheduledListing(makeRow({ images: jsonImages(20) }), h);

    expect(listingId).toBe("4242");
    expect(createDraftListing).toHaveBeenCalledTimes(1);
    expect(vi.mocked(createDraftListing).mock.calls[0][0]).toBe(111);
    expect(vi.mocked(createDraftListing).mock.calls[0][1]).toMatchObject({ title: "Halloween mug", taxonomyId: 1234 });
    expect(h.onListingCreated).toHaveBeenCalledWith("4242");

    const uploads = vi.mocked(uploadListingImage).mock.calls.map(([p]) => p);
    expect(uploads).toHaveLength(20);
    uploads.forEach((p, i) => {
      const image = storedImages("alice", 20)[i];
      expect(p).toMatchObject({ shopId: 111, listingId: 4242, rank: i + 1, overwrite: true, altText: image.altText });
      expect(Buffer.from(p.bytes).toString()).toBe(`bytes of ${image.key}`);
    });
    expect(vi.mocked(getObject).mock.calls.map(([key]) => key)).toEqual(storedImages("alice", 20).map((i) => i.key));

    // Details, then every image, and activation last.
    expect(calls[0]).toBe("create");
    expect(calls.at(-1)).toBe("activate");
    expect(calls.indexOf("activate")).toBeGreaterThan(calls.indexOf("image:20"));
    expect(activateListing).toHaveBeenCalledWith(111, 4242);
  });

  test("assigns variation photos by stored image position, with the value ids Etsy gave the grid, before activating", async () => {
    storeImages(3);
    const spec = {
      ...VALID_SPEC,
      newListing: {
        ...VALID_SPEC.newListing,
        variations: {
          products: [
            { propertyValues: [{ propertyId: 513, name: "Finish", valueIds: [1], values: ["Glossy"] }] },
            { propertyValues: [{ propertyId: 513, name: "Finish", valueIds: [2], values: ["Matte"] }] },
          ],
          imagesByValue: [
            { propertyId: 513, valueId: 1, value: "Glossy", imageIndex: 2 },
            { propertyId: 513, valueId: 2, value: "Matte", imageIndex: 0 },
          ],
        },
      },
    };
    draftHolds(spec);
    await publishScheduledListing(makeRow(), hooks());
    // uploadListingImage's mock gives rank r the id 100 + r.
    expect(updateVariationImages).toHaveBeenCalledWith(111, 4242, [
      { propertyId: 513, valueId: 9001, imageId: 103 },
      { propertyId: 513, valueId: 9002, imageId: 101 },
    ]);
    expect(calls.indexOf("variation-images")).toBeGreaterThan(calls.indexOf("image:3"));
    expect(calls.indexOf("activate")).toBeGreaterThan(calls.indexOf("variation-images"));
  });

  test("every variation gets the listing's processing profile when it has no per-variation one", async () => {
    storeImages(3);
    draftHolds({
      ...VALID_SPEC,
      newListing: {
        ...VALID_SPEC.newListing,
        readinessStateId: 1441577564343,
        variations: {
          products: [
            { propertyValues: [{ propertyId: 513, name: "Finish", valueIds: [1], values: ["Glossy"] }] },
            { propertyValues: [{ propertyId: 513, name: "Finish", valueIds: [2], values: ["Matte"] }], readinessStateId: 55 },
          ],
          readinessStateOnProperty: [],
        },
      },
    });
    await publishScheduledListing(makeRow(), hooks());
    const sent = vi.mocked(updateListingInventory).mock.calls[0][1];
    expect(sent.products.map((p) => p.readinessStateId)).toEqual([1441577564343, 55]);
  });

  test("every variation gets the listing's SKU when it has no per-variation one", async () => {
    storeImages(3);
    draftHolds({
      ...VALID_SPEC,
      newListing: {
        ...VALID_SPEC.newListing,
        sku: "HG-000763",
        variations: {
          products: [
            { propertyValues: [{ propertyId: 513, name: "Finish", valueIds: [1], values: ["Glossy"] }] },
            { propertyValues: [{ propertyId: 513, name: "Finish", valueIds: [2], values: ["Matte"] }], sku: "OWN-SKU" },
          ],
          skuOnProperty: [],
        },
      },
    });
    await publishScheduledListing(makeRow(), hooks());
    const sent = vi.mocked(updateListingInventory).mock.calls[0][1];
    expect(sent.products.map((p) => p.sku)).toEqual(["HG-000763", "OWN-SKU"]);
  });

  test("authenticates with the stored refresh token and saves Etsy's rotated one", async () => {
    storeImages(3);
    await publishScheduledListing(makeRow(), hooks());
    expect(getDecryptedRefreshToken).toHaveBeenCalledWith("alice", "111");
    expect(refreshSession).toHaveBeenCalledWith("stored-refresh");
    expect(saveConnectionTokens).toHaveBeenCalledWith("alice", "111", expect.objectContaining({ refreshToken: "rotated-refresh", accessToken: "fresh-access" }));
    expect(vi.mocked(withEtsyAccessToken).mock.calls[0][0]).toBe("fresh-access");
  });

  test("reuses a cached access token instead of spending a token call", async () => {
    storeImages(3);
    vi.mocked(getCachedAccessToken).mockResolvedValueOnce("cached-access");
    await publishScheduledListing(makeRow(), hooks());
    expect(refreshSession).not.toHaveBeenCalled();
    expect(vi.mocked(withEtsyAccessToken).mock.calls[0][0]).toBe("cached-access");
  });

  test("a retry reuses the listing a previous attempt created instead of creating another", async () => {
    storeImages(3);
    const h = hooks();
    const listingId = await publishScheduledListing(makeRow({ etsyListingId: "777" }), h);
    expect(listingId).toBe("777");
    expect(createDraftListing).not.toHaveBeenCalled();
    expect(h.onListingCreated).not.toHaveBeenCalled();
    expect(vi.mocked(uploadListingImage).mock.calls.every(([p]) => p.listingId === 777)).toBe(true);
    expect(activateListing).toHaveBeenCalledWith(111, 777);
  });

  test("an image missing from storage fails the attempt before the listing is activated", async () => {
    storeImages(2); // the third is missing
    await expect(publishScheduledListing(makeRow(), hooks())).rejects.toThrow("Image 3 is missing from storage.");
    expect(activateListing).not.toHaveBeenCalled();
  });

  test("a failed follow-up step fails the attempt — the listing is never activated half set up", async () => {
    storeImages(3);
    vi.mocked(setListingProperty).mockRejectedValueOnce(new Error("invalid value"));
    const spec = {
      ...VALID_SPEC,
      newListing: {
        ...VALID_SPEC.newListing,
        properties: [{ propertyId: 200, name: "Primary color", valueIds: [1], values: ["Black"] }],
      },
    };
    draftHolds(spec);
    const h = hooks();
    await expect(publishScheduledListing(makeRow(), h)).rejects.toThrow(
      "Primary color: invalid value — nothing was left on Etsy.",
    );
    expect(uploadListingImage).not.toHaveBeenCalled();
    expect(activateListing).not.toHaveBeenCalled();
    expect(deleteEtsyListing).toHaveBeenCalledWith(4242);
    expect(h.onListingDeleted).toHaveBeenCalledTimes(1);
  });

  test("a failed image upload deletes the unfinished listing from Etsy", async () => {
    storeImages(3);
    vi.mocked(uploadListingImage).mockRejectedValueOnce(new Error("Etsy 500"));
    await expect(publishScheduledListing(makeRow(), hooks())).rejects.toThrow("Image 1: Etsy 500");
    expect(deleteEtsyListing).toHaveBeenCalledWith(4242);
    expect(activateListing).not.toHaveBeenCalled();
  });

  test("when the delete is refused too, it says the draft is still on Etsy and keeps its id for the retry", async () => {
    storeImages(3);
    vi.mocked(uploadListingImage).mockRejectedValueOnce(new Error("Etsy 500"));
    vi.mocked(deleteEtsyListing).mockRejectedValueOnce(new Error("403 insufficient scope"));
    const h = hooks();
    await expect(publishScheduledListing(makeRow(), h)).rejects.toThrow(
      "couldn't be deleted (403 insufficient scope)",
    );
    expect(h.onListingDeleted).not.toHaveBeenCalled();
  });

  test("an invalid draft, a deleted draft, or no images, fails without calling Etsy", async () => {
    draftHolds({ ...VALID_SPEC, mode: "existing" });
    await expect(publishScheduledListing(makeRow(), hooks())).rejects.toThrow(/details are invalid/);
    draft.current = null;
    await expect(publishScheduledListing(makeRow(), hooks())).rejects.toThrow(/no longer exists/);
    await expect(publishScheduledListing(makeRow({ images: [] as unknown as ScheduledListing["images"] }), hooks())).rejects.toThrow(/no images/);
    expect(refreshSession).not.toHaveBeenCalled();
    expect(createDraftListing).not.toHaveBeenCalled();
  });

  test("a shop that's no longer connected fails with a clear message", async () => {
    vi.mocked(getDecryptedRefreshToken).mockResolvedValueOnce(null);
    await expect(publishScheduledListing(makeRow(), hooks())).rejects.toThrow(/no longer connected/);
    expect(createDraftListing).not.toHaveBeenCalled();
  });

  test("the publisher never composites — it doesn't import the mockup compositor at all", () => {
    const source = readFileSync(path.join(process.cwd(), "lib/scheduling/publisher.ts"), "utf8");
    const runner = readFileSync(path.join(process.cwd(), "lib/scheduling/runner.ts"), "utf8");
    expect(source).not.toMatch(/@\/lib\/mockup/);
    expect(runner).not.toMatch(/@\/lib\/mockup/);
  });
});
