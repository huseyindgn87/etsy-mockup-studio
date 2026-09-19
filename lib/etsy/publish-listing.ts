/**
 * Validation and listing-creation steps for publishing a listing to Etsy,
 * shared by the editor's immediate Publish (app/api/mockups/render/route.ts)
 * and the scheduled-listing runner (lib/scheduling/publisher.ts). Moved here
 * verbatim from the render route so both paths build exactly the same listing.
 *
 * Server-only — the creation steps call Etsy.
 */

import {
  setListingInventorySku,
  setListingProperty,
  updateListingInventory,
  updateListingPersonalization,
  updateListingSettings,
  type DraftListingInput,
} from "@/lib/etsy/listing-create";
import { WHEN_MADE_VALUES, WHO_MADE_OPTIONS, howItsMadeError } from "@/lib/etsy/listing-classification";
import {
  PERSONALIZATION_FIELD_TYPES,
  personalizationQuestionsError,
  type PersonalizationQuestionInput,
} from "@/lib/etsy/listing-personalization";
import { MAX_COMBINATIONS_HARD_CAP } from "@/lib/etsy/variation-limits";

/**
 * Etsy's "How it's made" classification — `who_made`/`is_supply`/`when_made`
 * plus production partners (required when `who_made` is `someone_else`).
 * Always the user's own choice on the How it's made tab; never borrowed from
 * `listingId`'s source listing.
 */
export interface HowItsMadeSpec {
  whoMade?: string;
  isSupply?: boolean;
  whenMade?: string;
  productionPartnerIds?: number[];
}
/** One personalization question, in the same shape as `PersonalizationQuestionInput` — see `listing-personalization.ts`. */
export interface PersonalizationQuestionSpec {
  questionId?: number;
  questionText?: string;
  instructions?: string;
  required?: boolean;
  fieldType?: string;
  maxAllowedCharacters?: number;
  maxAllowedFiles?: number;
  options?: string[];
}
export interface PublishSpec {
  /**
   * "existing" — append to `listingId` (never replaces unless `overwrite`). Requires `listingId`.
   * "copy"     — new draft from `newListing` (the edited form), upload there.
   *              Requires `listingId`, the copied listing, which is never read.
   * "new"      — the same, `listingId` optional.
   * A live listing is never modified except in "existing" mode, and even then
   * images are only added unless the caller explicitly sets `overwrite`.
   */
  mode?: "existing" | "copy" | "new";
  listingId?: number;
  startRank?: number;
  /** "existing" mode only. Replace the image at each rank. Default false. */
  overwrite?: boolean;
  /** Required for "copy" and "new" — see {@link HowItsMadeSpec}. */
  howItsMade?: HowItsMadeSpec;
  /** Optional, "copy"/"new" only — 0 to `PERSONALIZATION_MAX_QUESTIONS` questions. Omitted/empty -> no personalization is set. */
  personalization?: PersonalizationQuestionSpec[];
  newListing?: {
    title?: string;
    description?: string;
    tags?: string[];
    materials?: string[];
    taxonomyId?: number;
    shopSectionId?: number | null;
    /** Required by Etsy for every physical listing. */
    readinessStateId?: number;
    /** Copied from the source listing onto the draft; the form has no field for it. */
    shippingProfileId?: number | null;
    /** Copied from the source listing onto the draft; the form has no field for it. */
    returnPolicyId?: number | null;
    properties?: {
      propertyId: number;
      valueIds: number[];
      values: string[];
      scaleId?: number | null;
    }[];
    price?: number;
    quantity?: number;
    sku?: string;
    /** Not settable at draft creation — sent via a follow-up updateListing call. Omitted -> not featured. */
    featuredRank?: number;
    /** Not settable at draft creation — sent via a follow-up updateListing call. */
    shouldAutoRenew?: boolean;
    /** Present -> use the Inventory API's variation grid instead of the single SKU above. */
    variations?: {
      priceOnProperty?: number[];
      quantityOnProperty?: number[];
      skuOnProperty?: number[];
      readinessStateOnProperty?: number[];
      products: {
        propertyValues: { propertyId: number; name?: string; valueIds: (number | null)[]; values: string[]; scaleId?: number }[];
        price?: number;
        quantity?: number;
        sku?: string;
        readinessStateId?: number;
        /** Etsy still requires every combination to be supplied; false just marks it inactive. Defaults to true. */
        enabled?: boolean;
      }[];
      /**
       * The photo for a value of the one photo variation: by rendered job
       * (`jobIndex`) or by position in the upload order (`imageIndex`).
       * `value` finds the id Etsy assigned to a free-text value.
       */
      imagesByValue?: { propertyId: number; valueId: number; value?: string; jobIndex?: number; imageIndex?: number }[];
    };
  };
}

/** Etsy's own tag rules: at most 13 tags, each at most 20 characters. */
export function sanitizeTags(tags: unknown): string[] {
  if (!Array.isArray(tags)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const t of tags) {
    if (typeof t !== "string") continue;
    const trimmed = t.trim().slice(0, 20);
    const key = trimmed.toLowerCase();
    if (!trimmed || seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
    if (out.length >= 13) break;
  }
  return out;
}

export interface PropertyEntry {
  propertyId: number;
  name: string;
  valueIds: number[];
  values: string[];
  scaleId?: number | null;
}

/** Drop malformed property entries rather than fail the whole publish. */
export function sanitizeProperties(raw: unknown): PropertyEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: PropertyEntry[] = [];
  for (const p of raw) {
    if (!p || typeof p !== "object") continue;
    const propertyId = (p as { propertyId?: unknown }).propertyId;
    const name = (p as { name?: unknown }).name;
    const valueIds = (p as { valueIds?: unknown }).valueIds;
    const values = (p as { values?: unknown }).values;
    const scaleId = (p as { scaleId?: unknown }).scaleId;
    if (
      !Number.isInteger(propertyId) ||
      (propertyId as number) <= 0 ||
      !Array.isArray(valueIds) ||
      !Array.isArray(values) ||
      valueIds.length === 0 ||
      valueIds.length !== values.length ||
      !valueIds.every((v) => Number.isInteger(v) && v > 0) ||
      !values.every((v) => typeof v === "string")
    ) {
      continue;
    }
    out.push({
      propertyId: propertyId as number,
      name: typeof name === "string" && name ? name : `property #${propertyId as number}`,
      valueIds: valueIds as number[],
      values: values as string[],
      scaleId: typeof scaleId === "number" && scaleId > 0 ? scaleId : null,
    });
  }
  return out;
}

export interface CleanVariationProduct {
  propertyValues: { propertyId: number; name: string; valueIds: (number | null)[]; values: string[]; scaleId?: number }[];
  price?: number;
  quantity?: number;
  sku?: string;
  readinessStateId?: number;
  /** Etsy still requires every combination to be supplied; false just marks it inactive. */
  enabled: boolean;
}
export interface CleanVariations {
  products: CleanVariationProduct[];
  priceOnProperty: number[];
  quantityOnProperty: number[];
  skuOnProperty: number[];
  readinessStateOnProperty: number[];
  imagesByValue: VariationImageByValue[];
}

export interface VariationImageByValue {
  propertyId: number;
  valueId: number;
  value?: string;
  jobIndex?: number;
  imageIndex?: number;
}

export const positiveIntArray = (v: unknown): number[] =>
  Array.isArray(v) ? v.filter((x): x is number => Number.isInteger(x) && x > 0) : [];

/**
 * Validate a variation grid sent by the client. Malformed products / property
 * entries are dropped individually rather than failing the whole publish —
 * the client already built this from its own UI state, so a mismatch here
 * most likely means one row got out of sync, not that the whole grid is junk.
 */
export function sanitizeVariations(raw: unknown): CleanVariations | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const rawProducts = Array.isArray(r.products) ? r.products.slice(0, MAX_COMBINATIONS_HARD_CAP) : [];

  const products: CleanVariationProduct[] = [];
  for (const p of rawProducts) {
    if (!p || typeof p !== "object") continue;
    const pvRaw = (p as { propertyValues?: unknown }).propertyValues;
    if (!Array.isArray(pvRaw) || pvRaw.length === 0) continue;

    const propertyValues: CleanVariationProduct["propertyValues"] = [];
    let ok = true;
    for (const pv of pvRaw) {
      if (!pv || typeof pv !== "object") {
        ok = false;
        break;
      }
      const propertyId = (pv as { propertyId?: unknown }).propertyId;
      const name = (pv as { name?: unknown }).name;
      const valueIds = (pv as { valueIds?: unknown }).valueIds;
      const values = (pv as { values?: unknown }).values;
      if (
        !Number.isInteger(propertyId) ||
        (propertyId as number) <= 0 ||
        !Array.isArray(valueIds) ||
        !Array.isArray(values) ||
        valueIds.length === 0 ||
        valueIds.length !== values.length ||
        // null is a free-text value on an otherwise-real Etsy property (see VariationValuePicker).
        !valueIds.every((v) => v === null || (Number.isInteger(v) && v > 0)) ||
        !values.every((v) => typeof v === "string")
      ) {
        ok = false;
        break;
      }
      propertyValues.push({
        propertyId: propertyId as number,
        name: typeof name === "string" && name ? name : `property #${propertyId as number}`,
        valueIds: valueIds as (number | null)[],
        values: values as string[],
        ...(Number.isInteger((pv as { scaleId?: unknown }).scaleId) && ((pv as { scaleId: number }).scaleId > 0)
          ? { scaleId: (pv as { scaleId: number }).scaleId }
          : {}),
      });
    }
    if (!ok) continue;

    const price = (p as { price?: unknown }).price;
    const quantity = (p as { quantity?: unknown }).quantity;
    const sku = (p as { sku?: unknown }).sku;
    const readinessStateId = (p as { readinessStateId?: unknown }).readinessStateId;
    const enabled = (p as { enabled?: unknown }).enabled;
    products.push({
      propertyValues,
      price: typeof price === "number" && price > 0 ? price : undefined,
      quantity: typeof quantity === "number" && quantity >= 0 ? Math.trunc(quantity) : undefined,
      sku: typeof sku === "string" && sku.trim() ? sku.trim() : undefined,
      readinessStateId:
        Number.isInteger(readinessStateId) && (readinessStateId as number) > 0
          ? (readinessStateId as number)
          : undefined,
      enabled: enabled !== false, // never dropped — Etsy requires every combination, just marked inactive
    });
  }
  if (products.length === 0) return null;

  // Etsy takes variation images on one property only, with no duplicate values.
  const imagesRaw = Array.isArray(r.imagesByValue) ? r.imagesByValue : [];
  const imagesByValue: VariationImageByValue[] = [];
  const seenValues = new Set<string>();
  for (const i of imagesRaw) {
    if (!i || typeof i !== "object") continue;
    const o = i as Record<string, unknown>;
    const index = (x: unknown) => Number.isInteger(x) && (x as number) >= 0;
    if (!Number.isInteger(o.propertyId) || (o.propertyId as number) <= 0 || !Number.isInteger(o.valueId)) continue;
    const value = typeof o.value === "string" && o.value.trim() ? o.value.trim() : undefined;
    if ((o.valueId as number) <= 0 && !value) continue;
    if (!index(o.jobIndex) && !index(o.imageIndex)) continue;
    if (imagesByValue.length > 0 && imagesByValue[0].propertyId !== o.propertyId) continue;
    const valueKey = value ? `n:${value.toLowerCase()}` : `i:${o.valueId as number}`;
    if (seenValues.has(valueKey)) continue;
    seenValues.add(valueKey);
    imagesByValue.push({
      propertyId: o.propertyId as number,
      valueId: o.valueId as number,
      ...(value ? { value } : {}),
      ...(index(o.imageIndex) ? { imageIndex: o.imageIndex as number } : { jobIndex: o.jobIndex as number }),
    });
  }

  return {
    products,
    priceOnProperty: positiveIntArray(r.priceOnProperty),
    quantityOnProperty: positiveIntArray(r.quantityOnProperty),
    skuOnProperty: positiveIntArray(r.skuOnProperty),
    readinessStateOnProperty: positiveIntArray(r.readinessStateOnProperty),
    imagesByValue,
  };
}

/**
 * Variation images need the value ids Etsy holds, and Etsy assigns those
 * itself for free-text values (sent as `value_id: null`), and a replace can
 * renumber others. Looks each value up by property and name in the inventory
 * Etsy returned, then by its own id only if that id is still there; a value
 * found neither way is dropped (never sent with an id Etsy would refuse).
 */
export function resolveVariationImageValueIds(
  images: readonly VariationImageByValue[],
  inventory: unknown,
): VariationImageByValue[] {
  const products = (inventory as { products?: unknown } | null)?.products;
  const byName = new Map<string, number>();
  const present = new Set<string>();
  for (const p of Array.isArray(products) ? products : []) {
    const pvs = (p as { property_values?: unknown } | null)?.property_values;
    for (const pv of Array.isArray(pvs) ? pvs : []) {
      const { property_id, value_ids, values } = (pv ?? {}) as { property_id?: unknown; value_ids?: unknown; values?: unknown };
      if (!Array.isArray(values) || !Array.isArray(value_ids)) continue;
      values.forEach((v, k) => {
        const id = value_ids[k];
        if (typeof v !== "string" || !Number.isInteger(id) || id <= 0) return;
        present.add(`${property_id}:${id}`);
        const key = `${property_id}:${v.trim().toLowerCase()}`;
        if (!byName.has(key)) byName.set(key, id);
      });
    }
  }
  return images.flatMap((i) => {
    const found = i.value != null ? byName.get(`${i.propertyId}:${i.value.trim().toLowerCase()}`) : undefined;
    const valueId = found ?? (present.has(`${i.propertyId}:${i.valueId}`) ? i.valueId : null);
    return valueId == null ? [] : [{ ...i, valueId }];
  });
}

export const WHO_MADE_VALUES = WHO_MADE_OPTIONS.map((o) => o.value);

export interface ValidHowItsMade {
  whoMade: (typeof WHO_MADE_OPTIONS)[number]["value"];
  isSupply: boolean;
  whenMade: string;
  productionPartnerIds: number[];
}

/**
 * Validate the client's "How it's made" block. Unlike the other sanitizers
 * in this file, a malformed or missing value here fails the whole publish
 * (with a 400 and a clear message) rather than being silently dropped —
 * Etsy requires `who_made`/`when_made`/`is_supply` together on every
 * physical listing, and this app never fills them in on the caller's behalf
 * (see `getListingStructure` and `listing-classification.ts`).
 */
export function sanitizeHowItsMade(raw: unknown): { value: ValidHowItsMade } | { error: string } {
  if (!raw || typeof raw !== "object") {
    return {
      error: "How it's made is required — choose who made this item, what it is, and when it was made.",
    };
  }
  const r = raw as HowItsMadeSpec;
  if (typeof r.whoMade !== "string" || !(WHO_MADE_VALUES as string[]).includes(r.whoMade)) {
    return { error: "How it's made: choose who made this item." };
  }
  if (typeof r.whenMade !== "string" || !(WHEN_MADE_VALUES as readonly string[]).includes(r.whenMade)) {
    return { error: "How it's made: choose when this item was made." };
  }
  if (typeof r.isSupply !== "boolean") {
    return { error: "How it's made: choose whether this is a finished product or a supply." };
  }
  const productionPartnerIds = Array.isArray(r.productionPartnerIds)
    ? r.productionPartnerIds.filter((id): id is number => Number.isInteger(id) && id > 0)
    : [];
  const value: ValidHowItsMade = {
    whoMade: r.whoMade as ValidHowItsMade["whoMade"],
    isSupply: r.isSupply,
    whenMade: r.whenMade,
    productionPartnerIds,
  };
  const businessError = howItsMadeError(value);
  if (businessError) return { error: businessError };
  return { value };
}

export const PERSONALIZATION_FIELD_TYPE_VALUES = PERSONALIZATION_FIELD_TYPES.map((t) => t.value);

/**
 * Validate the client's personalization questions. Unlike `sanitizeHowItsMade`,
 * an omitted/empty array is valid — personalization is entirely optional. A
 * malformed or Etsy-incompatible set fails the whole publish (400, a clear
 * message) rather than being silently dropped or partially sent.
 */
export function sanitizePersonalization(
  raw: unknown,
): { value: PersonalizationQuestionInput[] } | { error: string } {
  if (raw == null) return { value: [] };
  if (!Array.isArray(raw)) {
    return { error: "publishTo.personalization must be an array." };
  }
  const value: PersonalizationQuestionInput[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") {
      return { error: "Personalization: each question must be an object." };
    }
    const q = item as PersonalizationQuestionSpec;
    if (
      typeof q.fieldType !== "string" ||
      !(PERSONALIZATION_FIELD_TYPE_VALUES as string[]).includes(q.fieldType)
    ) {
      return { error: "Personalization: choose a field type for every question." };
    }
    value.push({
      questionId: Number.isInteger(q.questionId) ? q.questionId : undefined,
      questionText: typeof q.questionText === "string" ? q.questionText : "",
      instructions: typeof q.instructions === "string" ? q.instructions : "",
      required: q.required === true,
      fieldType: q.fieldType as PersonalizationQuestionInput["fieldType"],
      maxAllowedCharacters: Number.isFinite(q.maxAllowedCharacters) ? Number(q.maxAllowedCharacters) : 0,
      maxAllowedFiles: Number.isFinite(q.maxAllowedFiles) ? Number(q.maxAllowedFiles) : 0,
      options: Array.isArray(q.options) ? q.options.filter((o): o is string => typeof o === "string") : [],
    });
  }
  const businessError = personalizationQuestionsError(value);
  if (businessError) return { error: businessError };
  return { value };
}

/** What creating a "copy" or "new" listing needs, once its {@link PublishSpec} is validated. */
export interface ListingCreationPlan {
  mode: "copy" | "new";
  /**
   * The listing a "copy" was made from (required) or a "new" one names
   * (optional). Never read: every value comes from `newListing`, the form
   * (and the draft's stored shipping profile / return policy) as it is now.
   */
  sourceListingId: number | null;
  howItsMade: ValidHowItsMade;
  personalization: PersonalizationQuestionInput[];
  newListing: NonNullable<PublishSpec["newListing"]>;
}

export interface ResolvedListingInput {
  input: DraftListingInput;
  price: number;
  quantity: number;
}

const positiveIdOrNull = (n: unknown): number | null =>
  typeof n === "number" && Number.isSafeInteger(n) && n > 0 ? n : null;

export function sanitizeMaterials(materials: unknown): string[] {
  if (!Array.isArray(materials)) return [];
  const out: string[] = [];
  for (const m of materials) {
    const t = typeof m === "string" ? m.trim() : "";
    if (t && !out.some((x) => x.toLowerCase() === t.toLowerCase())) out.push(t);
  }
  return out;
}

/**
 * The `createDraftListing` input for a plan. "copy" and "new" are the same:
 * every value comes from `newListing` — the form, plus the shipping profile and
 * return policy stored on the draft when it was copied. The source listing is
 * never read or written.
 */
export async function resolveDraftListingInput(plan: ListingCreationPlan): Promise<ResolvedListingInput> {
  const { howItsMade } = plan;
  const nl = plan.newListing;
  const quantity = Number.isInteger(nl.quantity) && (nl.quantity as number) > 0 ? (nl.quantity as number) : 1;
  const price = typeof nl.price === "number" && nl.price > 0 ? nl.price : 1;
  const title = typeof nl.title === "string" ? nl.title.trim() : "";

  return {
    price,
    quantity,
    input: {
      title,
      description: (typeof nl.description === "string" && nl.description) || title,
      quantity,
      price,
      whoMade: howItsMade.whoMade,
      isSupply: howItsMade.isSupply,
      whenMade: howItsMade.whenMade,
      productionPartnerIds: howItsMade.productionPartnerIds,
      // Validated positive by every caller (parseScheduledPublishSpec, the render route).
      taxonomyId: Number.isInteger(nl.taxonomyId) ? (nl.taxonomyId as number) : 0,
      shippingProfileId: positiveIdOrNull(nl.shippingProfileId),
      returnPolicyId: positiveIdOrNull(nl.returnPolicyId),
      readinessStateId:
        Number.isInteger(nl.readinessStateId) && (nl.readinessStateId as number) > 0
          ? (nl.readinessStateId as number)
          : null,
      shopSectionId: typeof nl.shopSectionId === "number" && nl.shopSectionId > 0 ? nl.shopSectionId : null,
      tags: sanitizeTags(nl.tags),
      materials: sanitizeMaterials(nl.materials),
    },
  };
}

/**
 * Called when one follow-up step fails. `step` names it ("Settings",
 * "Personalization", a property's name, "Variations", "SKU"). The editor's
 * Publish collects these and carries on; the runner throws, so a listing is
 * never activated half set up.
 */
export type ListingStepErrorHandler = (step: string, err: unknown) => void;

/**
 * The follow-up calls that give a just-created draft listing everything
 * `createDraftListing` can't set: settings, personalization, category
 * properties, and the SKU or variation grid. Each is a full replace, so
 * running them again on the same listing is safe. Returns the variation grid
 * that was saved, or `null` when there's none (or it failed to save).
 */
export async function applyListingDetails(
  shopId: number,
  listingId: number,
  plan: ListingCreationPlan,
  resolved: ResolvedListingInput,
  onStepError: ListingStepErrorHandler,
): Promise<CleanVariations | null> {
  const { personalization } = plan;
  const nl = plan.newListing;
  const { price, quantity } = resolved;
  let variations: CleanVariations | null = null;

  // featured_rank/should_auto_renew aren't part of createDraftListing either —
  // same follow-up-call pattern as properties/SKU/variations below.
  if ((nl.featuredRank != null || typeof nl.shouldAutoRenew === "boolean")) {
    try {
      await updateListingSettings(shopId, listingId, {
        featuredRank: nl.featuredRank,
        shouldAutoRenew: nl.shouldAutoRenew,
      });
    } catch (err) {
      onStepError("Settings", err);
    }
  }

  // Personalization isn't part of createDraftListing either — Etsy has
  // no personalization params on createDraftListing/updateListing at
  // all (its older flat fields are deprecated); it's a dedicated
  // resource set with a separate call once the listing exists. Skipped
  // entirely when nothing was configured, so a "copy"/"new" draft with
  // no personalization tab input never sends an empty-replacing call.
  if (personalization.length > 0) {
    try {
      await updateListingPersonalization(shopId, listingId, personalization);
    } catch (err) {
      onStepError("Personalization", err);
    }
  }

  // Category-specific properties and SKU aren't part of createDraftListing —
  // Etsy sets them with separate calls once the listing exists.
  for (const p of sanitizeProperties(nl.properties)) {
    try {
      await setListingProperty(shopId, listingId, p);
    } catch (err) {
      onStepError(p.name, err);
    }
  }
  variations = sanitizeVariations(nl.variations);
  if (variations) {
    // A variation grid replaces the single default product outright —
    // sending both would just have the second PUT overwrite the first.
    try {
      const saved = await updateListingInventory(listingId, {
        products: variations.products.map((p) => ({
          sku: p.sku,
          propertyValues: p.propertyValues,
          price: p.price ?? price,
          quantity: p.quantity ?? quantity,
          readinessStateId: p.readinessStateId ?? resolved.input.readinessStateId ?? undefined,
          enabled: p.enabled,
        })),
        priceOnProperty: variations.priceOnProperty,
        quantityOnProperty: variations.quantityOnProperty,
        skuOnProperty: variations.skuOnProperty,
        readinessStateOnProperty: variations.readinessStateOnProperty,
      });
      const imagesByValue = resolveVariationImageValueIds(variations.imagesByValue, saved);
      const matched = new Set(imagesByValue.map((i) => `${i.value}:${i.imageIndex}:${i.jobIndex}`));
      const unmatched = variations.imagesByValue.filter((i) => !matched.has(`${i.value}:${i.imageIndex}:${i.jobIndex}`));
      if (unmatched.length > 0) {
        const names = unmatched.map((i) => `“${i.value ?? i.valueId}”`).join(", ");
        onStepError("Variation photos", new Error(`${names} isn't an option in the saved inventory, so its photo wasn't attached.`));
      }
      variations = { ...variations, imagesByValue };
    } catch (err) {
      onStepError("Variations", err);
      variations = null; // grid failed to save -> don't try to attach images to it
    }
  } else {
    const sku = typeof nl.sku === "string" ? nl.sku.trim() : "";
    if (sku) {
      try {
        await setListingInventorySku(listingId, { sku, price, quantity });
      } catch (err) {
        onStepError("SKU", err);
      }
    }
  }
  return variations;
}
