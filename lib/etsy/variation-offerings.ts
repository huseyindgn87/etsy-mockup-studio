/**
 * The per-combination sub-tabs of the listing editor's Variations section
 * (Price, Quantity, SKU, Visibility, Photos, Processing): which rows each tab
 * shows, the "Individual <field>" toggles and what turning one off discards,
 * bulk edits, the SKU pattern generator, validation, and the inventory
 * payload the publish route sends to Etsy.
 *
 * Cells stay keyed exactly as `variation-combinations.ts` describes: by the
 * value ids of the variations a field varies by. A field that varies by no
 * variation is the listing-wide form field (`price`, `quantity`, `sku`,
 * `readinessStateId`).
 */

import type { ProcessingProfileOption } from "@/lib/etsy/processing-profiles";
import { MAX_SKU_LENGTH } from "@/lib/etsy/bulk-edit";
import { MAX_LISTING_IMAGES } from "@/lib/etsy/listing-image-limits";
import {
  buildCombinationModel,
  cellKeyFor,
  type CombinationField,
  type CombinationModel,
  type VariationDimension,
  type VariationState,
} from "@/lib/etsy/variation-combinations";

export interface OfferingState extends VariationState {
  price: string;
  quantity: string;
  sku: string;
  readinessStateId: number | null;
  /** The photo grid slot id chosen for each value id of the variation with `linksPhotos`. */
  variationPhotos: Record<string, string>;
}

export type OfferingTab = "price" | "quantity" | "sku" | "visibility" | "photos" | "processing";

export const OFFERING_TABS: readonly OfferingTab[] = ["price", "quantity", "sku", "visibility", "photos", "processing"];

export type FieldTab = "price" | "quantity" | "sku" | "processing";

export const TAB_FIELD: Record<FieldTab, CombinationField> = {
  price: "price",
  quantity: "quantity",
  sku: "sku",
  processing: "readiness",
};

export const FIELD_NOUN: Record<CombinationField, { one: string; many: string }> = {
  price: { one: "price", many: "prices" },
  quantity: { one: "quantity", many: "quantities" },
  sku: { one: "SKU", many: "SKUs" },
  readiness: { one: "processing profile", many: "processing profiles" },
};

export type ProcessingProfile = Pick<
  ProcessingProfileOption,
  "readinessStateId" | "readinessState" | "minProcessingDays" | "maxProcessingDays" | "displayLabel"
>;

/** The listing-wide value a field falls back to, as text. */
export function baseValue(state: OfferingState, field: CombinationField): string {
  if (field === "readiness") return state.readinessStateId == null ? "" : String(state.readinessStateId);
  return state[field];
}

function basePatch(field: CombinationField, text: string): Partial<OfferingState> {
  if (field === "readiness") {
    const id = Number.parseInt(text, 10);
    return { readinessStateId: Number.isInteger(id) && id > 0 ? id : null };
  }
  return { [field]: text } as Partial<OfferingState>;
}

/** The indices a field varies by — empty when it's listing-wide. */
export function individualIndices(state: VariationState, field: CombinationField): number[] {
  const toggle = state.variationToggles[field];
  if (!toggle.enabled) return [];
  return toggle.appliesTo.filter((i) => i >= 0 && i < state.variations.length);
}

export interface OfferingRow {
  /** The cell key — the value ids of the variations the tab varies by. */
  key: string;
  /** One value name per variation the tab varies by, in column order. */
  labels: string[];
  /** Every full combination this row stands for (`variationRowEnabled` keys). */
  combinationKeys: string[];
}

/** One row per distinct value of the `indices` variations, in grid order. */
export function offeringRows(model: CombinationModel, indices: readonly number[]): OfferingRow[] {
  if (indices.length === 0) return [];
  const rows = new Map<string, OfferingRow>();
  for (const c of model.combinations) {
    const key = cellKeyFor(indices, c.valueIds);
    let row = rows.get(key);
    if (!row) {
      row = { key, labels: indices.map((i) => c.values[i]), combinationKeys: [] };
      rows.set(key, row);
    }
    row.combinationKeys.push(c.key);
  }
  return [...rows.values()];
}

/** Rows whose label contains `query` (case-insensitive); all rows for a blank query. */
export function filterRows<T extends { labels: readonly string[] }>(rows: readonly T[], query: string): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...rows];
  return rows.filter((r) => r.labels.some((l) => l.toLowerCase().includes(q)));
}

function sameValue(field: CombinationField, a: string, b: string): boolean {
  if (field === "price" || field === "quantity") {
    const x = Number(a);
    const y = Number(b);
    if (Number.isFinite(x) && Number.isFinite(y)) return x === y;
  }
  return a.trim() === b.trim();
}

export interface IndividualChange {
  patch: Partial<OfferingState>;
  /** Rows whose own value would be thrown away — confirm before applying when above 0. */
  discarded: number;
}

/**
 * Checks or unchecks "Individual <field>" for one variation. Checking copies
 * each existing value (or the listing-wide one) onto the finer rows, so
 * nothing changes. Unchecking merges rows: each merged row keeps the first
 * value in grid order, and every row holding a different value counts as
 * discarded. Unchecking the last one moves that value to the listing-wide field.
 */
export function setIndividual(
  state: OfferingState,
  field: CombinationField,
  index: number,
  on: boolean,
): IndividualChange {
  const current = individualIndices(state, field);
  if (index < 0 || index >= state.variations.length || current.includes(index) === on) {
    return { patch: {}, discarded: 0 };
  }
  const next = on ? [...current, index].sort((a, b) => a - b) : current.filter((i) => i !== index);
  const model = buildCombinationModel(state.variations);
  const oldCells = state.variationRows[field];
  const base = baseValue(state, field);
  const cells: Record<string, string> = {};
  let discarded = 0;
  let nextBase = base;

  if (model.combinations.length === 0) {
    // Nothing to show per row yet (a variation without values): keep the cells as they are.
    Object.assign(cells, oldCells);
  } else if (on) {
    for (const c of model.combinations) {
      const key = cellKeyFor(next, c.valueIds);
      if (key in cells) continue;
      const old = current.length > 0 ? (oldCells[cellKeyFor(current, c.valueIds)] ?? "") : base;
      if (old.trim() !== "") cells[key] = old;
    }
  } else {
    const seen = new Set<string>();
    const kept = new Map<string, string>();
    for (const c of model.combinations) {
      const oldKey = cellKeyFor(current, c.valueIds);
      if (seen.has(oldKey)) continue;
      seen.add(oldKey);
      const old = oldCells[oldKey] ?? "";
      if (old.trim() === "") continue;
      const key = cellKeyFor(next, c.valueIds);
      const first = kept.get(key);
      if (first === undefined) kept.set(key, old);
      else if (!sameValue(field, first, old)) discarded++;
    }
    if (next.length === 0) {
      const only = kept.get("");
      if (only !== undefined) nextBase = only;
    } else {
      for (const [key, v] of kept) cells[key] = v;
    }
  }

  return {
    patch: {
      variationToggles: { ...state.variationToggles, [field]: { enabled: next.length > 0, appliesTo: next } },
      variationRows: { ...state.variationRows, [field]: next.length > 0 ? cells : {} },
      ...(nextBase !== base ? basePatch(field, nextBase) : {}),
    },
    discarded,
  };
}

/** Sets one cell, or the listing-wide value when `key` is null. */
export function setCell(
  state: OfferingState,
  field: CombinationField,
  key: string | null,
  text: string,
): Partial<OfferingState> {
  if (key == null) return basePatch(field, text);
  return { variationRows: { ...state.variationRows, [field]: { ...state.variationRows[field], [key]: text } } };
}

export type BulkOperation = "set" | "increase" | "decrease" | "increasePercent" | "decreasePercent";

export type BulkResult =
  | { ok: true; patch: Partial<OfferingState>; changed: number; skipped: number }
  | { ok: false; error: string };

const PRICE_RE = /^\d+(\.\d{1,2})?$/;
const QUANTITY_RE = /^\d+$/;
const PERCENT_RE = /^\d+(\.\d+)?$/;

function writeCells(
  state: OfferingState,
  field: CombinationField,
  keys: readonly string[] | null,
  compute: (current: string) => string | null,
): { patch: Partial<OfferingState>; changed: number; skipped: number } {
  const base = baseValue(state, field);
  if (keys == null) {
    const next = compute(base);
    if (next == null) return { patch: {}, changed: 0, skipped: 1 };
    return { patch: basePatch(field, next), changed: next === base ? 0 : 1, skipped: 0 };
  }
  const cells = { ...state.variationRows[field] };
  let changed = 0;
  let skipped = 0;
  for (const key of keys) {
    const own = cells[key] ?? "";
    const current = own.trim() !== "" ? own : base;
    const next = compute(current);
    if (next == null) {
      skipped++;
      continue;
    }
    if (next !== own) changed++;
    cells[key] = next;
  }
  return { patch: { variationRows: { ...state.variationRows, [field]: cells } }, changed, skipped };
}

/**
 * Price or quantity bulk edit over `keys` (the rows currently shown), or the
 * listing-wide value when `keys` is null. Rows with no value to change are
 * skipped by increase/decrease; an edit that would make any value negative
 * changes nothing.
 */
export function applyNumericBulk(
  state: OfferingState,
  field: "price" | "quantity",
  keys: readonly string[] | null,
  operation: BulkOperation,
  amountText: string,
): BulkResult {
  const amount = amountText.trim();
  const percent = operation === "increasePercent" || operation === "decreasePercent";
  if (percent && field !== "price") return { ok: false, error: "Percentages only apply to price." };
  if (percent ? !PERCENT_RE.test(amount) : !(field === "price" ? PRICE_RE : QUANTITY_RE).test(amount)) {
    return {
      ok: false,
      error: percent
        ? "Enter a percentage, e.g. 10."
        : field === "price"
          ? "Enter an amount with at most two decimals, e.g. 2.50."
          : "Enter a whole number, e.g. 5.",
    };
  }
  const n = Number(amount);
  let negatives = 0;
  const format = (x: number) => (field === "price" ? (Math.round(x * 100) / 100).toFixed(2) : String(Math.round(x)));
  const result = writeCells(state, field, keys, (current) => {
    if (operation === "set") return format(n);
    const valid = field === "price" ? PRICE_RE.test(current.trim()) : QUANTITY_RE.test(current.trim());
    if (!valid) return null;
    const c = Number(current);
    const x =
      operation === "increase" ? c + n
      : operation === "decrease" ? c - n
      : operation === "increasePercent" ? c * (1 + n / 100)
      : c * (1 - n / 100);
    if (Math.round(x * 100) / 100 < 0) {
      negatives++;
      return null;
    }
    return format(x);
  });
  if (negatives > 0) {
    const noun = FIELD_NOUN[field];
    return {
      ok: false,
      error: `That would make ${negatives} ${negatives === 1 ? noun.one : noun.many} negative — nothing was changed.`,
    };
  }
  return { ok: true, ...result };
}

/**
 * Processing bulk edit: set every shown row to one profile, or move each row
 * to the profile of the same kind whose minimum and maximum processing days
 * are both `days` longer (or shorter). Rows with no such profile are skipped.
 */
export function applyProcessingBulk(
  state: OfferingState,
  keys: readonly string[] | null,
  operation: "set" | "increase" | "decrease",
  amountText: string,
  profiles: readonly ProcessingProfile[],
): BulkResult {
  const amount = amountText.trim();
  if (operation === "set") {
    const profile = profiles.find((p) => String(p.readinessStateId) === amount);
    if (!profile) return { ok: false, error: "Choose a processing profile." };
    return { ok: true, ...writeCells(state, "readiness", keys, () => amount) };
  }
  if (!QUANTITY_RE.test(amount) || Number(amount) === 0) {
    return { ok: false, error: "Enter a number of days, e.g. 2." };
  }
  const days = Number(amount) * (operation === "increase" ? 1 : -1);
  return {
    ok: true,
    ...writeCells(state, "readiness", keys, (current) => {
      const from = profiles.find((p) => String(p.readinessStateId) === current.trim());
      if (!from) return null;
      const to = profiles.find(
        (p) =>
          p.readinessState === from.readinessState &&
          p.minProcessingDays === from.minProcessingDays + days &&
          p.maxProcessingDays === from.maxProcessingDays + days,
      );
      return to ? String(to.readinessStateId) : null;
    }),
  };
}

/**
 * Fills SKUs from a template, one per row in the order given. Tokens:
 * `{Size}` (a variation's name, any case) or `{1}`–`{3}` (its column) insert
 * that row's value; `{#}` inserts a counter starting at `start`, zero-padded
 * to the number of `#`s (`{###}` → 001).
 */
export function generateSkus(
  template: string,
  rows: readonly OfferingRow[],
  variations: readonly VariationDimension[],
  indices: readonly number[],
  start: number,
): { ok: true; cells: Record<string, string> } | { ok: false; error: string } {
  if (!template.trim()) return { ok: false, error: "Enter a SKU pattern, e.g. TEE-{Size}-{###}." };
  if (!Number.isInteger(start) || start < 0) return { ok: false, error: "The counter must start at a whole number." };
  const parts: ({ text: string } | { column: number } | { pad: number })[] = [];
  const re = /\{([^{}]*)\}/g;
  let last = 0;
  for (let m = re.exec(template); m; m = re.exec(template)) {
    if (m.index > last) parts.push({ text: template.slice(last, m.index) });
    last = m.index + m[0].length;
    const token = m[1].trim();
    if (/^#+$/.test(token)) {
      parts.push({ pad: token.length });
      continue;
    }
    const column = /^[1-9]$/.test(token)
      ? Number(token) - 1
      : variations.findIndex((v) => v.name.trim().toLowerCase() === token.toLowerCase());
    if (column < 0 || column >= variations.length) return { ok: false, error: `Unknown token {${token}}.` };
    const at = indices.indexOf(column);
    if (at < 0) {
      return {
        ok: false,
        error: `SKU doesn't vary by ${variations[column].name || `variation ${column + 1}`}, so {${token}} has no single value — check "Individual SKU" for it first.`,
      };
    }
    parts.push({ column: at });
  }
  if (last < template.length) parts.push({ text: template.slice(last) });

  const cells: Record<string, string> = {};
  for (let r = 0; r < rows.length; r++) {
    const sku = parts
      .map((p) =>
        "text" in p ? p.text : "column" in p ? rows[r].labels[p.column] : String(start + r).padStart(p.pad, "0"),
      )
      .join("")
      .trim();
    if (sku.length > MAX_SKU_LENGTH) {
      return { ok: false, error: `The SKU for ${rows[r].labels.join(" / ")} is longer than Etsy's limit of ${MAX_SKU_LENGTH}.` };
    }
    cells[rows[r].key] = sku;
  }
  return { ok: true, cells };
}

/** The variation photos are assigned on, or null. Etsy allows only one. */
export function photoPropertyIndex(variations: readonly VariationDimension[]): number | null {
  const i = variations.findIndex((v) => v.linksPhotos);
  return i < 0 ? null : i;
}

/** The assignments that still point at a value of the photo variation. */
export function prunedVariationPhotos(
  variations: readonly VariationDimension[],
  photos: Record<string, string>,
): Record<string, string> {
  const index = photoPropertyIndex(variations);
  const ids = new Set(index == null ? [] : variations[index].valueIds.map(String));
  const keys = Object.keys(photos);
  if (keys.every((k) => ids.has(k))) return photos;
  return Object.fromEntries(keys.filter((k) => ids.has(k)).map((k) => [k, photos[k]]));
}

/** Moves photo assignment to another variation (or none); the old assignments are discarded. */
export function setPhotoProperty(state: OfferingState, index: number | null): IndividualChange {
  if (index != null && (index < 0 || index >= state.variations.length)) return { patch: {}, discarded: 0 };
  if (photoPropertyIndex(state.variations) === index) return { patch: {}, discarded: 0 };
  return {
    patch: {
      variations: state.variations.map((v, i) => ({ ...v, linksPhotos: i === index })),
      variationPhotos: {},
    },
    discarded: Object.keys(prunedVariationPhotos(state.variations, state.variationPhotos)).length,
  };
}

export interface OfferingError {
  tab: OfferingTab;
  /** The row's key (a value id on the Photos tab), or null for the listing-wide control. */
  key: string | null;
  message: string;
}

function priceError(text: string): string | null {
  const t = text.trim();
  if (!t) return "Enter a price.";
  if (!PRICE_RE.test(t)) return "Enter a price with at most two decimals, e.g. 12.50.";
  if (Number(t) <= 0) return "Price must be greater than 0.";
  return null;
}

function quantityError(text: string): string | null {
  const t = text.trim();
  if (!t) return "Enter a quantity.";
  if (!QUANTITY_RE.test(t)) return "Quantity must be a whole number of 0 or more.";
  return null;
}

function skuError(text: string): string | null {
  return text.trim().length > MAX_SKU_LENGTH ? `SKU is longer than Etsy's limit of ${MAX_SKU_LENGTH}.` : null;
}

function processingError(text: string): string | null {
  return text.trim() ? null : "Choose a processing profile.";
}

const FIELD_CHECKS: { tab: FieldTab; check: (text: string) => string | null; listingWide: boolean }[] = [
  { tab: "price", check: priceError, listingWide: true },
  { tab: "quantity", check: quantityError, listingWide: true },
  { tab: "sku", check: skuError, listingWide: true },
  // A listing-wide processing profile is the Shipping section's to report.
  { tab: "processing", check: processingError, listingWide: false },
];

/**
 * Everything wrong with the per-combination data, in tab order then row
 * order. Empty while there's no variation grid to publish.
 */
export function validateOfferings(state: OfferingState, photoSlotIds: readonly string[]): OfferingError[] {
  const model = buildCombinationModel(state.variations);
  if (model.count === 0 || model.tooMany) return [];
  const errors: OfferingError[] = [];
  for (const { tab, check, listingWide } of FIELD_CHECKS) {
    const field = TAB_FIELD[tab];
    const indices = individualIndices(state, field);
    const base = baseValue(state, field);
    if (indices.length === 0) {
      const message = listingWide ? check(base) : null;
      if (message) errors.push({ tab, key: null, message });
      continue;
    }
    for (const row of offeringRows(model, indices)) {
      const own = state.variationRows[field][row.key] ?? "";
      const message = check(own.trim() !== "" ? own : base);
      if (message) errors.push({ tab, key: row.key, message });
    }
  }
  const photoIndex = photoPropertyIndex(state.variations);
  if (photoIndex != null) {
    const v = state.variations[photoIndex];
    for (const id of v.valueIds) {
      const slotId = state.variationPhotos[String(id)];
      if (slotId == null) continue;
      const at = photoSlotIds.indexOf(slotId);
      if (at < 0) {
        errors.push({ tab: "photos", key: String(id), message: "That photo is no longer in the listing's photos." });
      } else if (at >= MAX_LISTING_IMAGES) {
        errors.push({
          tab: "photos",
          key: String(id),
          message: `Only the first ${MAX_LISTING_IMAGES} photos are uploaded — choose one of those.`,
        });
      }
    }
  }
  return errors.sort((a, b) => OFFERING_TABS.indexOf(a.tab) - OFFERING_TABS.indexOf(b.tab));
}

export interface InventoryPayloadProduct {
  propertyValues: { propertyId: number; name: string; valueIds: (number | null)[]; values: string[] }[];
  price?: number;
  quantity?: number;
  sku?: string;
  readinessStateId?: number;
  enabled: boolean;
}

export interface InventoryPayload {
  priceOnProperty: number[];
  quantityOnProperty: number[];
  skuOnProperty: number[];
  readinessStateOnProperty: number[];
  products: InventoryPayloadProduct[];
  /**
   * The photo for each value of the one photo variation. `imageIndex` is the
   * photo's position in the upload order; `value` lets the server find the
   * value id Etsy assigned to a free-text value once the inventory is saved.
   */
  imagesByValue: { propertyId: number; valueId: number; value: string; imageIndex: number }[];
}

/**
 * The publish route's `newListing.variations`: every combination as one
 * product, each field read from the cell it's stored under. A blank cell (or
 * a listing-wide field) is left out, so the server fills in the listing's own
 * price and quantity. Hidden combinations are still sent — Etsy requires
 * every combination — with `enabled: false`.
 */
export function buildInventoryPayload(
  state: OfferingState,
  photoSlotIds: readonly string[],
): InventoryPayload | undefined {
  const dims = state.variations;
  const model = buildCombinationModel(dims);
  if (dims.length === 0 || model.combinations.length === 0) return undefined;

  const read = (field: CombinationField, valueIds: readonly number[]): string => {
    const indices = individualIndices(state, field);
    if (indices.length === 0) return "";
    return (state.variationRows[field][cellKeyFor(indices, valueIds)] ?? "").trim();
  };

  const products = model.combinations.map((c): InventoryPayloadProduct => {
    const price = read("price", c.valueIds);
    const quantity = read("quantity", c.valueIds);
    const sku = read("sku", c.valueIds);
    const readiness = Number.parseInt(read("readiness", c.valueIds), 10);
    return {
      propertyValues: dims.map((d, i) => ({
        propertyId: d.propertyId,
        name: d.name,
        // A negative id is a free-text value on a real Etsy property — Etsy expects value_id null.
        valueIds: [c.valueIds[i] < 0 ? null : c.valueIds[i]],
        values: [c.values[i]],
      })),
      price: PRICE_RE.test(price) && Number(price) > 0 ? Math.round(Number(price) * 100) / 100 : undefined,
      quantity: QUANTITY_RE.test(quantity) ? Number(quantity) : undefined,
      sku: sku || undefined,
      readinessStateId: Number.isInteger(readiness) && readiness > 0 ? readiness : undefined,
      enabled: state.variationRowEnabled[c.key] !== false,
    };
  });

  const onProperty = (field: CombinationField) => individualIndices(state, field).map((i) => dims[i].propertyId);

  const imagesByValue: InventoryPayload["imagesByValue"] = [];
  const photoIndex = photoPropertyIndex(dims);
  if (photoIndex != null) {
    const d = dims[photoIndex];
    d.valueIds.forEach((valueId, i) => {
      const slotId = state.variationPhotos[String(valueId)];
      const imageIndex = slotId == null ? -1 : photoSlotIds.indexOf(slotId);
      if (imageIndex >= 0 && imageIndex < MAX_LISTING_IMAGES) {
        imagesByValue.push({ propertyId: d.propertyId, valueId, value: d.values[i], imageIndex });
      }
    });
  }

  return {
    priceOnProperty: onProperty("price"),
    quantityOnProperty: onProperty("quantity"),
    skuOnProperty: onProperty("sku"),
    readinessStateOnProperty: onProperty("readiness"),
    products,
    imagesByValue,
  };
}
