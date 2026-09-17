import { describe, expect, test } from "vitest";
import { MAX_LISTING_IMAGES } from "@/lib/etsy/listing-image-limits";
import { coerceScheduledImages, parseScheduledImages, parseScheduledPublishSpec } from "../publish-spec";
import { imageSlot, isOwnedRenderKey, renderImageKey, slotIndex } from "../render-keys";
import { imageMeta, SET_A, SET_B, VALID_SPEC } from "./fixtures";

describe("parseScheduledImages — the 20-image limit", () => {
  test("Etsy's limit is 20 images per listing", () => {
    expect(MAX_LISTING_IMAGES).toBe(20);
  });

  test("accepts 20 images, each keyed to its slot in order", () => {
    const result = parseScheduledImages(imageMeta(20), "alice", SET_A);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.images).toHaveLength(20);
    expect(result.images.map((i) => i.key)).toEqual(
      Array.from({ length: 20 }, (_, i) => `scheduled/alice/${SET_A}/image-${String(i).padStart(2, "0")}`),
    );
    expect(result.images[19]).toMatchObject({ filename: "mug-20.jpg", contentType: "image/jpeg", altText: "View 20" });
  });

  test("rejects 21 images, and none at all", () => {
    expect(parseScheduledImages(imageMeta(21), "alice", SET_A)).toEqual({
      ok: false,
      error: "A listing can have at most 20 images.",
    });
    expect(parseScheduledImages([], "alice", SET_A).ok).toBe(false);
  });

  test("rejects an unsupported type or a bad render set id; cleans filenames and caps alt text", () => {
    expect(parseScheduledImages([{ filename: "a.webp", contentType: "image/webp" }], "alice", SET_A).ok).toBe(false);
    expect(parseScheduledImages(imageMeta(1), "alice", "not-a-uuid").ok).toBe(false);
    const result = parseScheduledImages(
      [{ filename: "../../etc/passwd", contentType: "image/png", altText: "x".repeat(600) }],
      "alice",
      SET_A,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.images[0].filename).toBe("image-1.png");
    expect(result.images[0].altText).toHaveLength(500);
  });

  test("coerceScheduledImages drops malformed stored entries", () => {
    expect(coerceScheduledImages([{ key: "k", filename: "f", contentType: "image/jpeg" }, { key: 1 }, null])).toHaveLength(1);
    expect(coerceScheduledImages("nope")).toEqual([]);
  });
});

describe("parseScheduledPublishSpec", () => {
  test("accepts a new listing and builds its creation plan", () => {
    const result = parseScheduledPublishSpec(VALID_SPEC);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan).toMatchObject({ mode: "new", sourceListingId: null, personalization: [] });
    expect(result.plan.howItsMade).toMatchObject({ whoMade: "i_did", whenMade: "made_to_order" });
  });

  test("refuses to schedule adding photos to an existing listing", () => {
    const result = parseScheduledPublishSpec({ ...VALID_SPEC, mode: "existing", listingId: 5 });
    expect(result).toEqual({ ok: false, error: expect.stringMatching(/existing listing can't be scheduled/) });
  });

  test("a copy needs its source listing; a new listing needs a title and category", () => {
    expect(parseScheduledPublishSpec({ ...VALID_SPEC, mode: "copy" }).ok).toBe(false);
    expect(parseScheduledPublishSpec({ ...VALID_SPEC, mode: "copy", listingId: 99 }).ok).toBe(true);
    expect(parseScheduledPublishSpec({ ...VALID_SPEC, newListing: { ...VALID_SPEC.newListing, title: " " } }).ok).toBe(false);
    expect(
      parseScheduledPublishSpec({ ...VALID_SPEC, newListing: { ...VALID_SPEC.newListing, taxonomyId: undefined } }).ok,
    ).toBe(false);
    expect(parseScheduledPublishSpec({ ...VALID_SPEC, howItsMade: undefined }).ok).toBe(false);
    expect(parseScheduledPublishSpec(null).ok).toBe(false);
  });

  test("variation images tied to render jobs are dropped from a scheduled listing; ones by image position are kept", () => {
    const result = parseScheduledPublishSpec({
      ...VALID_SPEC,
      newListing: {
        ...VALID_SPEC.newListing,
        variations: {
          products: [],
          imagesByValue: [
            { propertyId: 1, valueId: 2, jobIndex: 0 },
            { propertyId: 1, valueId: 3, value: "Red", imageIndex: 4 },
          ],
        },
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.spec.newListing?.variations?.imagesByValue).toEqual([
      { propertyId: 1, valueId: 3, value: "Red", imageIndex: 4 },
    ]);
  });
});

describe("render keys", () => {
  test("slots run image-00 to image-19", () => {
    expect(imageSlot(0)).toBe("image-00");
    expect(imageSlot(19)).toBe("image-19");
    expect(slotIndex("image-19")).toBe(19);
    expect(slotIndex("image-20")).toBeNull();
    expect(slotIndex("image-5")).toBeNull();
    expect(slotIndex("../image-01")).toBeNull();
  });

  test("isOwnedRenderKey accepts only this user's, this set's image slots", () => {
    expect(isOwnedRenderKey(renderImageKey("alice", SET_A, 3), "alice", SET_A)).toBe(true);
    for (const key of [
      "drafts/d1/own/photo",
      "templates/user/alice/x.png",
      renderImageKey("bob", SET_A, 3),
      renderImageKey("alice", SET_B, 3),
      `scheduled/alice/${SET_A}/../../drafts/d1/own/photo`,
      `scheduled/alice/${SET_A}/image-20`,
      `scheduled/alice/${SET_A}/`,
      `scheduled/alice/${SET_A}`,
    ]) {
      expect(isOwnedRenderKey(key, "alice", SET_A), key).toBe(false);
    }
    expect(isOwnedRenderKey(renderImageKey("alice", SET_A, 0), "alice", null)).toBe(false);
  });

  test("keys can't be built from a user or set id that would escape the prefix", () => {
    expect(() => renderImageKey("../bob", SET_A, 0)).toThrow();
    expect(() => renderImageKey("alice", "../x", 0)).toThrow();
  });
});
