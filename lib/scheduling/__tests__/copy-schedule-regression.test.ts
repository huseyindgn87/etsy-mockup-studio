/**
 * Regression for HG-000932/933: a copied listing, edited, scheduled, edited
 * again and then run must reach Etsy as the final form — nothing from the
 * source listing, nothing from the form as it was when scheduled.
 */

import { beforeEach, describe, expect, test, vi } from "vitest";

const { etsy, drafts, objects, record } = vi.hoisted(() => {
  const etsy: { call: string; args: unknown[] }[] = [];
  return {
    etsy,
    drafts: new Map<string, Record<string, unknown>>(),
    objects: new Map<string, Buffer>(),
    record:
      (call: string, result?: (...args: unknown[]) => unknown) =>
      async (...args: unknown[]) => {
        etsy.push({ call, args });
        return result?.(...args);
      },
  };
});

vi.mock("@/lib/db/prisma", () => ({
  prisma: {
    listingDraft: {
      findFirst: vi.fn(async ({ where }: { where: { id: string; userId: string } }) => {
        const d = drafts.get(where.id);
        return d && d.userId === where.userId ? d : null;
      }),
    },
  },
}));
vi.mock("@/lib/etsy/auth", () => ({
  withEtsyAccessToken: vi.fn(async (_token: string, fn: () => Promise<unknown>) => fn()),
}));
vi.mock("@/lib/etsy/oauth", () => ({
  refreshSession: vi.fn(async () => ({ accessToken: "a", refreshToken: "r", expiresAt: 0, userId: "1" })),
}));
vi.mock("@/lib/etsy/shop-connections", () => ({
  getDecryptedRefreshToken: vi.fn(async () => "stored-refresh"),
  getCachedAccessToken: vi.fn(async () => "cached-access"),
  saveConnectionTokens: vi.fn(async () => {}),
}));
vi.mock("@/lib/etsy/listing-create", () => ({
  // The source listing on Etsy — none of its content may reach the new listing.
  getListingStructure: record("getListingStructure", () => ({
    title: "SOURCE title",
    description: "SOURCE description",
    tags: ["source-tag"],
    materials: ["source material"],
    price: 99,
    quantity: 99,
    taxonomyId: 1,
    readinessStateId: 2,
    shippingProfileId: 55,
    returnPolicyId: 66,
  })),
  createDraftListing: record("createDraftListing", () => 4242),
  activateListing: record("activateListing"),
  setListingProperty: record("setListingProperty"),
  setListingInventorySku: record("setListingInventorySku"),
  updateListingInventory: record("updateListingInventory", (_id, inv) => ({
    products: (inv as { products: { propertyValues: { propertyId: number; valueIds: (number | null)[]; values: string[] }[] }[] }).products.map((p) => ({
      property_values: p.propertyValues.map((v) => ({ property_id: v.propertyId, value_ids: v.valueIds, values: v.values })),
    })),
  })),
  updateVariationImages: record("updateVariationImages"),
  updateListingPersonalization: record("updateListingPersonalization"),
  updateListingSettings: record("updateListingSettings"),
}));
vi.mock("@/lib/etsy/listing-images", () => ({
  uploadListingImage: record("uploadListingImage", (p) => ({
    listingImageId: 100 + (p as { rank: number }).rank,
    rank: (p as { rank: number }).rank,
    url: null,
  })),
}));
vi.mock("@/lib/storage/r2", () => ({
  getObject: vi.fn(async (key: string) => (objects.has(key) ? { body: objects.get(key)!, contentType: "image/jpeg" } : null)),
}));

import type { ScheduledListing } from "@prisma/client";
import type { ListingFormValue } from "@/app/(app)/mockups/ListingForm";
import { publishSpecFromForm } from "@/lib/etsy/listing-publish-spec";
import { publishScheduledListing } from "../publisher";
import { parseScheduledImages, parseScheduledPublishSpec } from "../publish-spec";
import { SET_A } from "./fixtures";

const SOURCE_ID = 500;
const toggle = (appliesTo: number[] = []) => ({ enabled: appliesTo.length > 0, appliesTo });

/** A copy's form as the editor prefilled it from the source. */
const COPIED: ListingFormValue = {
  title: "SOURCE title",
  description: "SOURCE description",
  tags: ["source-tag"],
  taxonomyId: 1,
  taxonomyPath: "Source",
  shopSectionId: 9,
  shopSectionTitle: "Source section",
  properties: {},
  price: "99.00",
  quantity: "99",
  sku: "",
  readinessStateId: 2,
  whoMade: "i_did",
  isSupply: false,
  whenMade: "made_to_order",
  productionPartnerIds: [],
  personalizationQuestions: [],
  variations: [],
  variationToggles: { price: toggle(), readiness: toggle(), quantity: toggle(), sku: toggle() },
  variationRows: { price: {}, readiness: {}, quantity: {}, sku: {} },
  variationRowEnabled: {},
  variationPhotos: {},
  featureListing: false,
  promoteWithAds: false,
  autoRenew: true,
};

/** Every field edited, as it was when the listing was scheduled. */
const AT_SCHEDULE: ListingFormValue = {
  ...COPIED,
  title: "Scheduled title",
  description: "Scheduled description",
  tags: ["scheduled"],
  taxonomyId: 10,
  shopSectionId: 11,
  price: "12.00",
  quantity: "5",
  sku: "HG-OLD",
  readinessStateId: 12,
};

/** Every field edited again after scheduling — what Etsy must get. */
const FINAL: ListingFormValue = {
  ...COPIED,
  title: "HG-000933 Final title",
  description: "Final description",
  tags: ["final", "comfort colors"],
  taxonomyId: 1623,
  taxonomyPath: "Clothing > T-shirts",
  shopSectionId: 5150,
  shopSectionTitle: "Halloween",
  properties: { 200: { name: "Primary color", valueIds: [1], values: ["Black"], scaleId: null } } as ListingFormValue["properties"],
  price: "24.50",
  quantity: "7",
  sku: "HG-000933",
  readinessStateId: 777,
  whoMade: "someone_else",
  isSupply: false,
  whenMade: "made_to_order",
  productionPartnerIds: [31],
  personalizationQuestions: [
    { questionText: "Name to print", instructions: "Up to 20 letters", required: true, fieldType: "text_input", maxAllowedCharacters: 20, maxAllowedFiles: 0, options: [] },
  ] as ListingFormValue["personalizationQuestions"],
  featureListing: true,
  autoRenew: false,
};

const SLOTS = ["own:front", "job:m1::d1"];

function saveDraft(form: ListingFormValue, altText: Record<string, string>) {
  drafts.set("draft-933", {
    userId: "alice",
    formData: form,
    photosData: { imageOrder: [{ kind: "own", id: "front" }, { kind: "job", key: "m1::d1" }], altTextBySlot: altText },
    sourceMode: "copy",
    sourceListingId: String(SOURCE_ID),
  });
}

/** Schedules the draft as the editor does: its spec validated, its images uploaded with their grid slots. */
function schedule(form: ListingFormValue, altText: Record<string, string>): ScheduledListing {
  const spec = parseScheduledPublishSpec(
    publishSpecFromForm(form, { mode: "copy", listingId: SOURCE_ID, photoSlotIds: SLOTS }),
  );
  if (!spec.ok) throw new Error(spec.error);
  const images = parseScheduledImages(
    SLOTS.map((slotId, i) => ({ filename: `img-${i}.jpg`, contentType: "image/jpeg", altText: altText[slotId], slotId })),
    "alice",
    SET_A,
  );
  if (!images.ok) throw new Error(images.error);
  for (const image of images.images) objects.set(image.key, Buffer.from(image.key));
  return {
    id: "s933",
    kind: "publish",
    userId: "alice",
    shopId: "111",
    draftId: "draft-933",
    activeDraftId: "draft-933",
    scheduledAt: new Date("2026-09-20T12:00:00Z"),
    timezone: "UTC",
    status: "publishing",
    publishSpec: spec.spec,
    renderSetId: SET_A,
    images: images.images,
    attemptCount: 0,
    nextAttemptAt: null,
    lastError: null,
    etsyListingId: null,
  } as unknown as ScheduledListing;
}

const calls = (name: string) => etsy.filter((c) => c.call === name).map((c) => c.args);
const hooks = () => ({ onListingCreated: vi.fn(async () => {}) });

beforeEach(() => {
  etsy.length = 0;
  drafts.clear();
  objects.clear();
});

describe("a copied listing, edited, scheduled and edited again", () => {
  test("publishes the final form field by field — nothing from the source, nothing from schedule time", async () => {
    saveDraft(AT_SCHEDULE, { "own:front": "old alt", "job:m1::d1": "old alt 2" });
    const row = schedule(AT_SCHEDULE, { "own:front": "old alt", "job:m1::d1": "old alt 2" });
    saveDraft(FINAL, { "own:front": "Front of the black tee", "job:m1::d1": "Back print" });

    await expect(publishScheduledListing(row, hooks())).resolves.toBe("4242");

    expect(calls("createDraftListing")).toEqual([
      [
        111,
        {
          title: "HG-000933 Final title",
          description: "Final description",
          quantity: 7,
          price: 24.5,
          whoMade: "someone_else",
          isSupply: false,
          whenMade: "made_to_order",
          productionPartnerIds: [31],
          taxonomyId: 1623,
          // Not in the form: the only things read from the source.
          shippingProfileId: 55,
          returnPolicyId: 66,
          readinessStateId: 777,
          shopSectionId: 5150,
          tags: ["final", "comfort colors"],
          materials: [],
        },
      ],
    ]);
    expect(calls("setListingProperty")).toEqual([
      [111, 4242, expect.objectContaining({ propertyId: 200, valueIds: [1], values: ["Black"] })],
    ]);
    expect(calls("setListingInventorySku")).toEqual([[4242, { sku: "HG-000933", price: 24.5, quantity: 7 }]]);
    expect(calls("updateListingPersonalization")).toEqual([
      [111, 4242, [expect.objectContaining({ questionText: "Name to print", instructions: "Up to 20 letters", required: true, fieldType: "text_input", maxAllowedCharacters: 20 })]],
    ]);
    expect(calls("updateListingSettings")).toEqual([[111, 4242, { featuredRank: 1, shouldAutoRenew: false }]]);
    expect(calls("uploadListingImage").map(([p]) => [(p as { rank: number }).rank, (p as { altText?: string }).altText])).toEqual([
      [1, "Front of the black tee"],
      [2, "Back print"],
    ]);
    expect(calls("activateListing")).toEqual([[111, 4242]]);

    // The live source listing is read for shipping/return policy only, never written to.
    const writes = etsy.filter((c) => c.call !== "getListingStructure");
    expect(JSON.stringify(writes.map((c) => c.args))).not.toContain(String(SOURCE_ID));
  });

  test("a variation grid edited after scheduling is what Etsy gets, photos linked by the final grid", async () => {
    saveDraft(AT_SCHEDULE, {});
    const row = schedule(AT_SCHEDULE, {});
    saveDraft(
      {
        ...FINAL,
        variations: [
          { propertyId: 200, name: "Primary color", isCustom: false, valueIds: [21, 22], values: ["Black", "White"], linksPhotos: true },
        ],
        variationToggles: { price: toggle([0]), quantity: toggle(), readiness: toggle(), sku: toggle([0]) },
        variationRows: { price: { "21": "25.00", "22": "26.00" }, quantity: {}, readiness: {}, sku: { "21": "HG-933-BLK", "22": "HG-933-WHT" } },
        variationPhotos: { "21": "job:m1::d1", "22": "own:front" },
      },
      {},
    );

    await publishScheduledListing(row, hooks());

    expect(calls("setListingInventorySku")).toEqual([]);
    const [[listingId, inventory]] = calls("updateListingInventory") as [number, { products: { sku?: string; price?: number; quantity?: number }[]; priceOnProperty?: number[]; skuOnProperty?: number[] }][];
    expect(listingId).toBe(4242);
    expect(inventory.products.map((p) => [p.sku, p.price, p.quantity])).toEqual([
      ["HG-933-BLK", 25, 7],
      ["HG-933-WHT", 26, 7],
    ]);
    expect(inventory.priceOnProperty).toEqual([200]);
    expect(inventory.skuOnProperty).toEqual([200]);
    // Rank r got image id 100 + r: Black → slot 2, White → slot 1.
    expect(calls("updateVariationImages")).toEqual([
      [111, 4242, [
        { propertyId: 200, valueId: 21, imageId: 102 },
        { propertyId: 200, valueId: 22, imageId: 101 },
      ]],
    ]);
  });
});
