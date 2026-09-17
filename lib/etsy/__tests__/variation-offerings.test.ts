import { beforeEach, describe, expect, it, vi } from "vitest";

const etsyFetch = vi.fn<(path: string, init?: RequestInit) => Promise<Response>>();
vi.mock("@/lib/etsy/auth", () => ({
  etsyFetch: (path: string, init?: RequestInit) => etsyFetch(path, init),
}));

import { updateListingInventory, updateVariationImages } from "@/lib/etsy/listing-create";
import { resolveVariationImageValueIds, sanitizeVariations } from "@/lib/etsy/publish-listing";
import { buildCombinationModel, type VariationDimension } from "@/lib/etsy/variation-combinations";
import {
  applyNumericBulk,
  applyProcessingBulk,
  buildInventoryPayload,
  filterRows,
  generateSkus,
  offeringRows,
  prunedVariationPhotos,
  setIndividual,
  setPhotoProperty,
  validateOfferings,
  type OfferingState,
} from "@/lib/etsy/variation-offerings";

const SIZE: VariationDimension = {
  propertyId: 100,
  name: "Size",
  isCustom: false,
  valueIds: [11, 12, 13],
  values: ["S", "M", "L"],
  linksPhotos: false,
};
const COLOR: VariationDimension = {
  propertyId: 200,
  name: "Primary color",
  isCustom: false,
  valueIds: [21, 22],
  values: ["Black", "White"],
  linksPhotos: false,
};

const toggle = (appliesTo: number[] = []) => ({ enabled: appliesTo.length > 0, appliesTo });

function state(overrides: Partial<OfferingState> = {}): OfferingState {
  return {
    variations: [SIZE, COLOR],
    variationToggles: { price: toggle(), quantity: toggle(), sku: toggle(), readiness: toggle() },
    variationRows: { price: {}, quantity: {}, sku: {}, readiness: {} },
    variationRowEnabled: {},
    price: "10.00",
    quantity: "5",
    sku: "",
    readinessStateId: 7,
    variationPhotos: {},
    ...overrides,
  };
}

const json = (body: unknown): Response =>
  ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) }) as Response;

beforeEach(() => etsyFetch.mockReset());

describe("offering rows", () => {
  const model = buildCombinationModel([SIZE, COLOR]);

  it("lists one row per value of the variations a field varies by, in grid order", () => {
    expect(offeringRows(model, [1]).map((r) => [r.key, r.labels, r.combinationKeys])).toEqual([
      ["21", ["Black"], ["11:21", "12:21", "13:21"]],
      ["22", ["White"], ["11:22", "12:22", "13:22"]],
    ]);
    expect(offeringRows(model, [0, 1])).toHaveLength(6);
    expect(offeringRows(model, [])).toEqual([]);
  });

  it("filters by any label, ignoring case", () => {
    const rows = offeringRows(model, [0, 1]);
    expect(filterRows(rows, "black").map((r) => r.key)).toEqual(["11:21", "12:21", "13:21"]);
    expect(filterRows(rows, " ")).toHaveLength(6);
  });
});

describe("individual-field toggles", () => {
  it("checking a variation copies the listing-wide value onto every row, losing nothing", () => {
    const change = setIndividual(state(), "price", 0, true);
    expect(change.discarded).toBe(0);
    expect(change.patch.variationToggles!.price).toEqual({ enabled: true, appliesTo: [0] });
    expect(change.patch.variationRows!.price).toEqual({ "11": "10.00", "12": "10.00", "13": "10.00" });
  });

  it("checking a second variation splits each row's value across the finer rows", () => {
    const s = state({
      variationToggles: { ...state().variationToggles, price: toggle([1]) },
      variationRows: { ...state().variationRows, price: { "21": "12.00", "22": "14.00" } },
    });
    const change = setIndividual(s, "price", 0, true);
    expect(change.discarded).toBe(0);
    expect(change.patch.variationToggles!.price.appliesTo).toEqual([0, 1]);
    expect(change.patch.variationRows!.price).toEqual({
      "11:21": "12.00",
      "11:22": "14.00",
      "12:21": "12.00",
      "12:22": "14.00",
      "13:21": "12.00",
      "13:22": "14.00",
    });
  });

  it("unchecking merges rows, keeps the first value and counts every different one as discarded", () => {
    const s = state({
      variationToggles: { ...state().variationToggles, price: toggle([0, 1]) },
      variationRows: {
        ...state().variationRows,
        price: { "11:21": "12.00", "11:22": "12", "12:21": "13.00", "12:22": "15.00", "13:21": "", "13:22": "16.00" },
      },
    });
    const change = setIndividual(s, "price", 1, false);
    // S: 12.00 == 12 (same number); M: 13 vs 15 (1 lost); L: blank vs 16 (nothing lost).
    expect(change.discarded).toBe(1);
    expect(change.patch.variationToggles!.price).toEqual({ enabled: true, appliesTo: [0] });
    expect(change.patch.variationRows!.price).toEqual({ "11": "12.00", "12": "13.00", "13": "16.00" });
  });

  it("unchecking the last variation moves the kept value to the listing-wide field", () => {
    const s = state({
      variationToggles: { ...state().variationToggles, quantity: toggle([1]) },
      variationRows: { ...state().variationRows, quantity: { "21": "3", "22": "8" } },
    });
    const change = setIndividual(s, "quantity", 1, false);
    expect(change.discarded).toBe(1);
    expect(change.patch).toMatchObject({
      quantity: "3",
      variationToggles: { quantity: { enabled: false, appliesTo: [] } },
      variationRows: { quantity: {} },
    });
  });

  it("uniform rows collapse without a warning; processing profiles collapse into readinessStateId", () => {
    const s = state({
      variationToggles: { ...state().variationToggles, readiness: toggle([0]) },
      variationRows: { ...state().variationRows, readiness: { "11": "9", "12": "9", "13": "9" } },
    });
    const change = setIndividual(s, "readiness", 0, false);
    expect(change.discarded).toBe(0);
    expect(change.patch.readinessStateId).toBe(9);
  });

  it("does nothing when the checkbox is already in that state", () => {
    expect(setIndividual(state(), "sku", 0, false)).toEqual({ patch: {}, discarded: 0 });
  });
});

describe("bulk apply", () => {
  const byColor = (price: Record<string, string>) =>
    state({
      variationToggles: { ...state().variationToggles, price: toggle([1]) },
      variationRows: { ...state().variationRows, price },
    });

  it("sets, increases, decreases and scales only the rows given", () => {
    const s = byColor({ "21": "12.00", "22": "20.00" });
    const set = applyNumericBulk(s, "price", ["21"], "set", "9.5");
    expect(set).toMatchObject({ ok: true, changed: 1, patch: { variationRows: { price: { "21": "9.50", "22": "20.00" } } } });
    expect(applyNumericBulk(s, "price", ["21", "22"], "increase", "1.25")).toMatchObject({
      patch: { variationRows: { price: { "21": "13.25", "22": "21.25" } } },
    });
    expect(applyNumericBulk(s, "price", ["22"], "decreasePercent", "15")).toMatchObject({
      patch: { variationRows: { price: { "21": "12.00", "22": "17.00" } } },
    });
    expect(applyNumericBulk(s, "price", ["21"], "increasePercent", "10")).toMatchObject({
      patch: { variationRows: { price: { "21": "13.20" } } },
    });
  });

  it("a blank row changes from the listing-wide value", () => {
    const s = byColor({ "21": "" });
    expect(applyNumericBulk(s, "price", ["21"], "increase", "2")).toMatchObject({
      patch: { variationRows: { price: { "21": "12.00" } } },
    });
  });

  it("refuses an edit that would make any value negative and changes nothing", () => {
    const s = byColor({ "21": "3.00", "22": "20.00" });
    expect(applyNumericBulk(s, "price", ["21", "22"], "decrease", "5")).toEqual({
      ok: false,
      error: "That would make 1 price negative — nothing was changed.",
    });
  });

  it("validates the amount, and percentages only apply to price", () => {
    expect(applyNumericBulk(state(), "price", null, "set", "-1")).toMatchObject({ ok: false });
    expect(applyNumericBulk(state(), "price", null, "set", "1.999")).toMatchObject({ ok: false });
    expect(applyNumericBulk(state(), "quantity", null, "set", "2.5")).toMatchObject({ ok: false });
    expect(applyNumericBulk(state(), "quantity", null, "increasePercent", "5")).toMatchObject({ ok: false });
  });

  it("with no individual rows edits the listing-wide value", () => {
    expect(applyNumericBulk(state(), "quantity", null, "increase", "4")).toMatchObject({
      ok: true,
      patch: { quantity: "9" },
    });
  });

  it("processing: sets a profile, or shifts to the profile with the same kind and days moved", () => {
    const profiles = [
      { readinessStateId: 1, readinessState: "made_to_order" as const, minProcessingDays: 1, maxProcessingDays: 3, displayLabel: "1-3 days" },
      { readinessStateId: 2, readinessState: "made_to_order" as const, minProcessingDays: 3, maxProcessingDays: 5, displayLabel: "3-5 days" },
      { readinessStateId: 3, readinessState: "ready_to_ship" as const, minProcessingDays: 3, maxProcessingDays: 5, displayLabel: "3-5 days" },
    ];
    const s = state({
      readinessStateId: null,
      variationToggles: { ...state().variationToggles, readiness: toggle([0]) },
      variationRows: { ...state().variationRows, readiness: { "11": "1", "12": "2", "13": "" } },
    });
    expect(applyProcessingBulk(s, ["11", "12", "13"], "increase", "2", profiles)).toMatchObject({
      ok: true,
      changed: 1,
      skipped: 2,
      patch: { variationRows: { readiness: { "11": "2", "12": "2", "13": "" } } },
    });
    expect(applyProcessingBulk(s, ["13"], "set", "3", profiles)).toMatchObject({
      patch: { variationRows: { readiness: { "13": "3" } } },
    });
    expect(applyProcessingBulk(s, ["13"], "set", "99", profiles)).toMatchObject({ ok: false });
  });
});

describe("SKU pattern generator", () => {
  const model = buildCombinationModel([SIZE, COLOR]);

  it("fills every row from property tokens and a zero-padded counter", () => {
    const rows = offeringRows(model, [0, 1]);
    const result = generateSkus("TEE-{Size}-{primary COLOR}-{###}", rows, [SIZE, COLOR], [0, 1], 8);
    expect(result).toEqual({
      ok: true,
      cells: {
        "11:21": "TEE-S-Black-008",
        "11:22": "TEE-S-White-009",
        "12:21": "TEE-M-Black-010",
        "12:22": "TEE-M-White-011",
        "13:21": "TEE-L-Black-012",
        "13:22": "TEE-L-White-013",
      },
    });
  });

  it("accepts column numbers and fills a 450-row grid in one call", () => {
    const big: VariationDimension[] = [
      { ...SIZE, valueIds: Array.from({ length: 45 }, (_, i) => i + 1), values: Array.from({ length: 45 }, (_, i) => `Z${i}`) },
      { ...COLOR, valueIds: Array.from({ length: 10 }, (_, i) => i + 101), values: Array.from({ length: 10 }, (_, i) => `C${i}`) },
    ];
    const rows = offeringRows(buildCombinationModel(big), [0, 1]);
    const result = generateSkus("{1}{2}-{#}", rows, big, [0, 1], 1);
    expect(result.ok && Object.keys(result.cells)).toHaveLength(450);
    expect(result.ok && result.cells["45:110"]).toBe("Z44C9-450");
  });

  it("refuses unknown tokens and properties the SKU doesn't vary by", () => {
    const rows = offeringRows(model, [0]);
    expect(generateSkus("{Colour}", rows, [SIZE, COLOR], [0], 1)).toEqual({ ok: false, error: "Unknown token {Colour}." });
    expect(generateSkus("{2}", rows, [SIZE, COLOR], [0], 1)).toMatchObject({
      ok: false,
      error: expect.stringContaining("doesn't vary by Primary color"),
    });
    expect(generateSkus(" ", rows, [SIZE, COLOR], [0], 1)).toMatchObject({ ok: false });
  });
});

describe("photo property", () => {
  it("assigns photos on one variation only and discards the old assignments when it moves", () => {
    const s = state({
      variations: [{ ...SIZE, linksPhotos: true }, COLOR],
      variationPhotos: { "11": "job:a", "12": "own:b" },
    });
    const change = setPhotoProperty(s, 1);
    expect(change.discarded).toBe(2);
    expect(change.patch.variations!.map((v) => v.linksPhotos)).toEqual([false, true]);
    expect(change.patch.variationPhotos).toEqual({});
    expect(setPhotoProperty(s, 0)).toEqual({ patch: {}, discarded: 0 });
    expect(setPhotoProperty(s, null).patch.variations!.every((v) => !v.linksPhotos)).toBe(true);
  });

  it("drops assignments whose value is gone", () => {
    const variations = [{ ...SIZE, linksPhotos: true, valueIds: [11], values: ["S"] }, COLOR];
    expect(prunedVariationPhotos(variations, { "11": "job:a", "12": "job:b" })).toEqual({ "11": "job:a" });
    const photos = { "11": "job:a" };
    expect(prunedVariationPhotos(variations, photos)).toBe(photos);
  });
});

describe("validation", () => {
  it("is empty for a complete grid and without variations", () => {
    expect(validateOfferings(state(), [])).toEqual([]);
    expect(validateOfferings(state({ variations: [], price: "" }), [])).toEqual([]);
  });

  it("reports each offending row in tab order, falling back to the listing-wide value for blank rows", () => {
    const s = state({
      price: "",
      readinessStateId: null,
      variationToggles: { price: toggle([1]), quantity: toggle([0]), sku: toggle(), readiness: toggle([1]) },
      variationRows: {
        price: { "21": "12.00", "22": "0" },
        quantity: { "11": "4", "12": "", "13": "2" },
        sku: {},
        readiness: { "21": "5" },
      },
      sku: "x".repeat(501),
      variations: [SIZE, { ...COLOR, linksPhotos: true }],
      variationPhotos: { "21": "job:gone", "22": "own:1" },
    });
    expect(validateOfferings(s, ["own:1"])).toEqual([
      { tab: "price", key: "22", message: "Price must be greater than 0." },
      { tab: "sku", key: null, message: "SKU is longer than Etsy's limit of 500." },
      { tab: "photos", key: "21", message: "That photo is no longer in the listing's photos." },
      { tab: "processing", key: "22", message: "Choose a processing profile." },
    ]);
  });

  it("flags a blank row with no listing-wide fallback, and a price with too many decimals", () => {
    const s = state({
      price: "",
      quantity: "",
      variationToggles: { ...state().variationToggles, price: toggle([0]), quantity: toggle([0]) },
      variationRows: { ...state().variationRows, price: { "11": "1.234", "12": "3" }, quantity: { "11": "1", "12": "1", "13": "1" } },
    });
    expect(validateOfferings(s, [])).toEqual([
      { tab: "price", key: "11", message: "Enter a price with at most two decimals, e.g. 12.50." },
      { tab: "price", key: "13", message: "Enter a price." },
    ]);
  });
});

describe("Etsy inventory payload", () => {
  const s = state({
    variations: [SIZE, { ...COLOR, linksPhotos: true, valueIds: [21, -1], values: ["Black", "Sunset"] }],
    variationToggles: { price: toggle([0]), quantity: toggle([0, 1]), sku: toggle([0, 1]), readiness: toggle() },
    variationRows: {
      price: { "11": "12.00", "12": "", "13": "14.5" },
      quantity: { "11:21": "0", "11:-1": "3" },
      sku: { "11:21": "TEE-S-BLK", "13:-1": " TEE-L-SUN " },
      readiness: {},
    },
    variationRowEnabled: { "12:-1": false },
    variationPhotos: { "21": "own:b", "-1": "job:a" },
  });

  it("sends every combination with its offering fields, on-property ids and one property's photo mapping", () => {
    const payload = buildInventoryPayload(s, ["job:a", "own:b"])!;
    expect(payload.products).toHaveLength(6);
    expect(payload.products[0]).toEqual({
      propertyValues: [
        { propertyId: 100, name: "Size", valueIds: [11], values: ["S"] },
        { propertyId: 200, name: "Primary color", valueIds: [21], values: ["Black"] },
      ],
      price: 12,
      quantity: 0,
      sku: "TEE-S-BLK",
      readinessStateId: undefined,
      enabled: true,
    });
    // A free-text value goes as value_id null; a blank cell is left for the server's listing-wide fallback.
    expect(payload.products[3]).toMatchObject({
      propertyValues: [{ valueIds: [12] }, { valueIds: [null], values: ["Sunset"] }],
      price: undefined,
      quantity: undefined,
      enabled: false,
    });
    expect(payload.products[5]).toMatchObject({ price: 14.5, sku: "TEE-L-SUN" });
    expect(payload.priceOnProperty).toEqual([100]);
    expect(payload.quantityOnProperty).toEqual([100, 200]);
    expect(payload.skuOnProperty).toEqual([100, 200]);
    expect(payload.readinessStateOnProperty).toEqual([]);
    expect(payload.imagesByValue).toEqual([
      { propertyId: 200, valueId: 21, value: "Black", imageIndex: 1 },
      { propertyId: 200, valueId: -1, value: "Sunset", imageIndex: 0 },
    ]);
  });

  it("is undefined without a grid", () => {
    expect(buildInventoryPayload(state({ variations: [] }), [])).toBeUndefined();
    expect(buildInventoryPayload(state({ variations: [{ ...SIZE, valueIds: [], values: [] }] }), [])).toBeUndefined();
  });

  it("round-trips through the server into Etsy's inventory and variation-images request bodies", async () => {
    const clean = sanitizeVariations(buildInventoryPayload(s, ["job:a", "own:b"]))!;
    expect(clean.products).toHaveLength(6);

    etsyFetch.mockResolvedValueOnce(
      json({
        products: [
          { property_values: [{ property_id: 100, value_ids: [11], values: ["S"] }, { property_id: 200, value_ids: [21], values: ["Black"] }] },
          { property_values: [{ property_id: 100, value_ids: [11], values: ["S"] }, { property_id: 200, value_ids: [987654], values: ["Sunset"] }] },
        ],
      }),
    );
    const saved = await updateListingInventory(555, {
      products: clean.products.map((p) => ({ ...p, price: p.price ?? 10, quantity: p.quantity ?? 5 })),
      priceOnProperty: clean.priceOnProperty,
      quantityOnProperty: clean.quantityOnProperty,
      skuOnProperty: clean.skuOnProperty,
      readinessStateOnProperty: clean.readinessStateOnProperty,
    });
    const body = JSON.parse(etsyFetch.mock.calls[0][1]!.body as string);
    expect(body.price_on_property).toEqual([100]);
    expect(body.quantity_on_property).toEqual([100, 200]);
    expect(body.sku_on_property).toEqual([100, 200]);
    expect(body.products[0]).toEqual({
      sku: "TEE-S-BLK",
      property_values: [
        { property_id: 100, property_name: "Size", value_ids: [11], values: ["S"] },
        { property_id: 200, property_name: "Primary color", value_ids: [21], values: ["Black"] },
      ],
      offerings: [{ price: 12, quantity: 0, is_enabled: true }],
    });
    expect(body.products[3].offerings).toEqual([{ price: 10, quantity: 5, is_enabled: false }]);
    expect(body.products[3].property_values[1].value_ids).toEqual([null]);

    // Etsy assigned "Sunset" its own id; the photo mapping uses it.
    const images = resolveVariationImageValueIds(clean.imagesByValue, saved);
    expect(images).toEqual([
      { propertyId: 200, valueId: 21, value: "Black", imageIndex: 1 },
      { propertyId: 200, valueId: 987654, value: "Sunset", imageIndex: 0 },
    ]);

    etsyFetch.mockResolvedValueOnce(json({ count: 2, results: [] }));
    await updateVariationImages(42, 555, images.map((i) => ({ propertyId: i.propertyId, valueId: i.valueId, imageId: 9000 + i.imageIndex! })));
    expect(JSON.parse(etsyFetch.mock.calls[1][1]!.body as string)).toEqual({
      variation_images: [
        { property_id: 200, value_id: 21, image_id: 9001 },
        { property_id: 200, value_id: 987654, image_id: 9000 },
      ],
    });
  });

  it("the server keeps variation images on one property only, without duplicate values", () => {
    const clean = sanitizeVariations({
      products: [{ propertyValues: [{ propertyId: 200, name: "Color", valueIds: [1], values: ["Red"] }] }],
      imagesByValue: [
        { propertyId: 200, valueId: 1, value: "Red", imageIndex: 0 },
        { propertyId: 100, valueId: 5, value: "S", imageIndex: 1 },
        { propertyId: 200, valueId: 1, value: "red", imageIndex: 2 },
        { propertyId: 200, valueId: -3, imageIndex: 2 },
        { propertyId: 200, valueId: 2, jobIndex: 1 },
      ],
    })!;
    expect(clean.imagesByValue).toEqual([
      { propertyId: 200, valueId: 1, value: "Red", imageIndex: 0 },
      { propertyId: 200, valueId: 2, jobIndex: 1 },
    ]);
  });
});
