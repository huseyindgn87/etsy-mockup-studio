/**
 * The field model behind bulk listing editing (`/listings/bulk`) — the left
 * sidebar's groups, which listing fields can be edited in bulk, the limits
 * Etsy imposes on them, and the validation both the editor screen and the
 * save route run.
 *
 * Dependency-free (no Prisma, no Etsy client) so the client screen and the
 * server route share exactly one definition of what a valid edit is — the
 * same split lib/drafts/constants.ts makes for draft caps.
 *
 * Deliberately narrow: every field here maps to a documented Etsy write.
 * A patch can need up to five different calls, which {@link splitPatch}
 * separates (see lib/etsy/bulk-apply.ts):
 *   - `updateListing`            — the plain listing fields
 *   - the inventory record       — price/quantity/SKU/processing profile
 *   - `updateListingProperty`    — the Optional group's category attributes
 *   - the personalization resource
 *   - the inventory record again — a full variation grid
 */

import {
  personalizationQuestionsError,
  PERSONALIZATION_FIELD_TYPES,
  type PersonalizationQuestionInput,
} from "@/lib/etsy/listing-personalization";
import { WHEN_MADE_VALUES, WHO_MADE_OPTIONS, howItsMadeError } from "@/lib/etsy/listing-classification";
import { MAX_COMBINATIONS_HARD_CAP } from "@/lib/etsy/variation-limits";

/** Etsy truncates longer titles; lib/etsy/listing-create.ts already slices to this. */
export const MAX_TITLE_LENGTH = 140;
/** Etsy's own tag rules — the same pair lib/etsy/publish-listing.ts's `sanitizeTags` enforces. */
export const MAX_TAGS = 13;
export const MAX_TAG_LENGTH = 20;
/** Matches the slice lib/etsy/listing-create.ts applies when writing a SKU. */
export const MAX_SKU_LENGTH = 500;
/**
 * Etsy's spec documents no count or length limit for `materials` (only a
 * character-class regex), so these are this app's own display bounds rather
 * than Etsy's — kept generous, and never used to silently drop a value.
 */
export const MAX_MATERIALS = 13;
export const MAX_MATERIAL_LENGTH = 45;

/** `item_weight_unit`, exactly as updateListing enumerates it. */
export const WEIGHT_UNITS = ["oz", "lb", "g", "kg"] as const;
export type WeightUnit = (typeof WEIGHT_UNITS)[number];
/** `item_dimensions_unit`, exactly as updateListing enumerates it. */
export const DIMENSION_UNITS = ["in", "ft", "mm", "cm", "m", "yd", "inches"] as const;
export type DimensionUnit = (typeof DIMENSION_UNITS)[number];

/**
 * The Optional group's fields. Every one is an Etsy *taxonomy property*, not
 * a listing column: which property ids exist — and which values they accept —
 * depend on the listing's own category, so each row resolves its own property
 * from its taxonomy (see `matches`) and the editor only offers values that
 * category actually has.
 */
export const ATTRIBUTE_FIELDS = [
  { key: "attr_primary_color", label: "Primary color", matches: ["primary color", "primary_color"] },
  { key: "attr_secondary_color", label: "Secondary color", matches: ["secondary color", "secondary_color"] },
  { key: "attr_holiday", label: "Holiday", matches: ["holiday"] },
  { key: "attr_occasion", label: "Occasion", matches: ["occasion"] },
  { key: "attr_materials", label: "Materials", matches: ["material", "materials"] },
  { key: "attr_size", label: "Size", matches: ["size"] },
  { key: "attr_sustainability", label: "Sustainability", matches: ["sustainability"] },
  { key: "attr_sleeve_length", label: "Sleeve length", matches: ["sleeve length", "sleeve_length"] },
  { key: "attr_neckline", label: "Neckline", matches: ["neckline"] },
  { key: "attr_clothing_style", label: "Clothing style", matches: ["clothing style", "clothing_style", "style"] },
  { key: "attr_graphic", label: "Graphic", matches: ["graphic"] },
  { key: "attr_closure", label: "Closure", matches: ["closure", "closure type", "closure_type"] },
] as const;

export type AttributeFieldKey = (typeof ATTRIBUTE_FIELDS)[number]["key"];

export function isAttributeField(field: BulkFieldKey): field is AttributeFieldKey {
  return ATTRIBUTE_FIELDS.some((a) => a.key === field);
}

/**
 * Find the taxonomy property one Optional field refers to, among the
 * properties of a listing's own category. Matched on Etsy's `name` and
 * `display_name` rather than a hard-coded property id: Etsy's ids aren't
 * documented as stable constants, and the same concept ("Size") is a
 * different property on different categories.
 */
export function findAttributeProperty<T extends { propertyId: number; name: string; displayName: string }>(
  field: AttributeFieldKey,
  properties: readonly T[],
): T | null {
  const spec = ATTRIBUTE_FIELDS.find((a) => a.key === field);
  if (!spec) return null;
  const wanted = spec.matches as readonly string[];
  const normalise = (s: string) => s.trim().toLowerCase().replace(/_/g, " ");
  // Exact match first so "Size" never loses to "Ring Size" on a category that has both.
  for (const want of wanted) {
    const exact = properties.find(
      (p) => normalise(p.name) === normalise(want) || normalise(p.displayName) === normalise(want),
    );
    if (exact) return exact;
  }
  return null;
}

export type BulkFieldKey =
  // Listings
  | "title"
  | "description"
  | "tags"
  | "materials"
  | "about"
  | "productionPartners"
  | "taxonomyId"
  | "shopSectionId"
  | "personalization"
  // Media — shown per listing, never bulk-written
  | "photos"
  | "videos"
  // Optional — category attributes
  | AttributeFieldKey
  // Inventory
  | "variations"
  | "price"
  | "quantity"
  | "sku"
  // Shipping
  | "readinessStateId"
  | "shippingProfileId"
  | "itemWeight"
  | "itemSize"
  | "returnPolicyId"
  // Kept editable through the API for the settings the specified sidebar has
  // no slot for — see BULK_GROUPS.
  | "shouldAutoRenew"
  | "isTaxable";

/**
 * Per-field character limits, for the editor's remaining-character counters.
 * Only fields Etsy actually limits appear here: `description` has no
 * documented maximum anywhere in Etsy's Open API v3 spec or its Listings
 * tutorial, so it deliberately gets no counter rather than an invented one.
 * `tags` and `materials` are lists, not text fields — see
 * {@link MAX_TAG_LENGTH} and {@link MAX_MATERIAL_LENGTH}.
 */
export const CHARACTER_LIMITS: Partial<Record<BulkFieldKey, number>> = {
  title: MAX_TITLE_LENGTH,
  sku: MAX_SKU_LENGTH,
};

/** Characters still available in `value` for `field`, or null when Etsy sets no limit. */
export function remainingCharacters(field: BulkFieldKey, value: string): number | null {
  const limit = CHARACTER_LIMITS[field];
  return limit == null ? null : limit - value.length;
}

/** One category attribute's chosen values, as `updateListingProperty` takes them. */
export interface BulkAttributeValue {
  propertyId: number;
  valueIds: number[];
  values: string[];
  scaleId?: number | null;
}

/** One product in a replacement variation grid. */
export interface BulkVariationProduct {
  propertyValues: { propertyId: number; name: string; valueIds: (number | null)[]; values: string[] }[];
  price?: number;
  quantity?: number;
  sku?: string;
  readinessStateId?: number;
  /** Etsy requires every combination to be supplied; false just marks it inactive. */
  enabled: boolean;
}

/** A full replacement of one listing's variation grid. */
export interface BulkVariations {
  products: BulkVariationProduct[];
  priceOnProperty: number[];
  quantityOnProperty: number[];
  skuOnProperty: number[];
  readinessStateOnProperty: number[];
}

/** One edit to one listing. Every key absent means "leave this listing's value alone". */
export interface BulkListingPatch {
  title?: string;
  description?: string;
  tags?: string[];
  materials?: string[];
  /** Etsy requires who/what/when together, so the About field always carries all three. */
  whoMade?: string;
  whenMade?: string;
  isSupply?: boolean;
  productionPartnerIds?: number[];
  taxonomyId?: number;
  /** Moving into a section only — see `parseBulkPatch` for why clearing isn't offered. */
  shopSectionId?: number;
  personalization?: PersonalizationQuestionInput[];
  shouldAutoRenew?: boolean;
  isTaxable?: boolean;
  shippingProfileId?: number;
  returnPolicyId?: number;
  itemWeight?: number;
  itemWeightUnit?: WeightUnit;
  itemLength?: number;
  itemWidth?: number;
  itemHeight?: number;
  itemDimensionsUnit?: DimensionUnit;
  /** Inventory-side — major currency units. */
  price?: number;
  /** Inventory-side. */
  quantity?: number;
  /** Inventory-side. */
  sku?: string;
  /** Inventory-side — the processing profile every physical listing carries. */
  readinessStateId?: number;
  /** Written one call per property. */
  attributes?: BulkAttributeValue[];
  /** Replaces the listing's whole product grid. */
  variations?: BulkVariations;
}

/** Fields written with `updateListing` (`PATCH /shops/{shop}/listings/{listing}`). */
export const LISTING_FIELDS = [
  "title",
  "description",
  "tags",
  "materials",
  "whoMade",
  "whenMade",
  "isSupply",
  "productionPartnerIds",
  "taxonomyId",
  "shopSectionId",
  "shouldAutoRenew",
  "isTaxable",
  "shippingProfileId",
  "returnPolicyId",
  "itemWeight",
  "itemWeightUnit",
  "itemLength",
  "itemWidth",
  "itemHeight",
  "itemDimensionsUnit",
] as const;

/** Fields written through the inventory record (`PUT /listings/{listing}/inventory`). */
export const INVENTORY_FIELDS = ["price", "quantity", "sku", "readinessStateId"] as const;

/** One field as the sidebar lists it. */
export interface BulkField {
  key: BulkFieldKey;
  label: string;
}

/** One collapsible group in the bulk editor's left sidebar. */
export interface BulkGroup {
  key: string;
  label: string;
  /** Every group collapses; the flag stays so a future always-open group has somewhere to say so. */
  collapsible: boolean;
  fields: readonly BulkField[];
}

const ATTRIBUTE_GROUP_FIELDS = ATTRIBUTE_FIELDS.map((a) => ({ key: a.key, label: a.label }));

/**
 * The sidebar, exactly as specified.
 *
 * A field may appear in more than one group — Title/Description/Tags are
 * reachable both from AI Edits and from Listings — so the editor identifies
 * the selected field by `group:field`, not by field alone.
 *
 * Two fields this module still validates and saves have no slot in this
 * structure: `shouldAutoRenew` and `isTaxable`. They stay in the patch model
 * and the save route (nothing server-side regressed), but the specified
 * sidebar has nowhere to put them, so the screen no longer offers them.
 */
export const BULK_GROUPS: readonly BulkGroup[] = [
  {
    key: "ai",
    label: "AI Edits",
    collapsible: true,
    fields: [
      { key: "title", label: "Title" },
      { key: "description", label: "Description" },
      { key: "tags", label: "Tags" },
    ],
  },
  {
    key: "media",
    label: "Media",
    collapsible: true,
    fields: [
      { key: "photos", label: "Photos" },
      { key: "videos", label: "Videos" },
    ],
  },
  {
    key: "listings",
    label: "Listings",
    collapsible: true,
    fields: [
      { key: "title", label: "Title" },
      { key: "description", label: "Description" },
      { key: "tags", label: "Tags" },
      { key: "materials", label: "Materials" },
      { key: "about", label: "About" },
      { key: "productionPartners", label: "Production partner" },
      { key: "taxonomyId", label: "Category" },
      { key: "shopSectionId", label: "Section" },
      { key: "personalization", label: "Personalization" },
    ],
  },
  {
    key: "optional",
    label: "Optional",
    collapsible: true,
    fields: ATTRIBUTE_GROUP_FIELDS,
  },
  {
    key: "inventory",
    label: "Inventory",
    collapsible: true,
    fields: [
      { key: "variations", label: "Variations" },
      { key: "price", label: "Price" },
      { key: "quantity", label: "Quantity" },
      { key: "sku", label: "SKU" },
    ],
  },
  {
    key: "shipping",
    label: "Shipping",
    collapsible: true,
    fields: [
      { key: "readinessStateId", label: "Processing profile" },
      { key: "shippingProfileId", label: "Shipping profile" },
      { key: "itemWeight", label: "Item weight" },
      { key: "itemSize", label: "Item size" },
      { key: "returnPolicyId", label: "Return policy" },
    ],
  },
];

/** Every field the sidebar can select, deduplicated. */
export const ALL_BULK_FIELDS: readonly BulkFieldKey[] = [
  ...new Set(BULK_GROUPS.flatMap((g) => g.fields.map((f) => f.key))),
];

/**
 * How the control above the listing rows behaves for a field:
 *   - "transform" — mode dropdown (add before / add after / find & replace) + text
 *   - "append"    — one value added to each row's existing list, never replacing it
 *   - "select"    — a dropdown of the valid Etsy values
 *   - "value"     — a plain input whose value is copied to each ticked row
 *   - "none"      — no bulk control (edited per listing only)
 */
export type BulkApplyKind = "transform" | "append" | "select" | "value" | "none";

const APPLY_KINDS: Record<BulkFieldKey, BulkApplyKind> = {
  title: "transform",
  description: "transform",
  tags: "append",
  materials: "append",
  about: "select",
  productionPartners: "select",
  taxonomyId: "select",
  shopSectionId: "select",
  personalization: "none",
  photos: "none",
  videos: "none",
  attr_primary_color: "select",
  attr_secondary_color: "select",
  attr_holiday: "select",
  attr_occasion: "select",
  attr_materials: "select",
  attr_size: "select",
  attr_sustainability: "select",
  attr_sleeve_length: "select",
  attr_neckline: "select",
  attr_clothing_style: "select",
  attr_graphic: "select",
  attr_closure: "select",
  variations: "none",
  price: "value",
  quantity: "value",
  sku: "value",
  readinessStateId: "select",
  shippingProfileId: "select",
  itemWeight: "value",
  itemSize: "value",
  returnPolicyId: "select",
  shouldAutoRenew: "select",
  isTaxable: "select",
};

export function applyKindFor(field: BulkFieldKey): BulkApplyKind {
  return APPLY_KINDS[field];
}

/**
 * Fields that never go through a listing patch. Media is edited per listing
 * on the shared photo/video grid and saved by `POST /api/etsy/listings/[id]/media`.
 */
export const READ_ONLY_FIELDS: readonly BulkFieldKey[] = ["photos", "videos"];

export function isReadOnlyField(field: BulkFieldKey): boolean {
  return READ_ONLY_FIELDS.includes(field);
}

export function isEmptyPatch(patch: BulkListingPatch): boolean {
  return Object.keys(patch).length === 0;
}

/** Splits a patch into the Etsy writes it needs. Any part may be empty. */
export function splitPatch(patch: BulkListingPatch): {
  listing: BulkListingPatch;
  inventory: BulkListingPatch;
  attributes: BulkAttributeValue[];
  personalization: PersonalizationQuestionInput[] | null;
  variations: BulkVariations | null;
} {
  const listing: BulkListingPatch = {};
  const inventory: BulkListingPatch = {};
  for (const key of LISTING_FIELDS) {
    if (key in patch) Object.assign(listing, { [key]: patch[key] });
  }
  for (const key of INVENTORY_FIELDS) {
    if (key in patch) Object.assign(inventory, { [key]: patch[key] });
  }
  return {
    listing,
    inventory,
    attributes: patch.attributes ?? [],
    personalization: patch.personalization ?? null,
    variations: patch.variations ?? null,
  };
}

/**
 * Normalises one tag list to Etsy's rules, dropping blanks and
 * case-insensitive duplicates. Mirrors `sanitizeTags` in
 * lib/etsy/publish-listing.ts — kept separate only so this module stays
 * dependency-free for the client.
 */
export function normalizeTags(tags: readonly string[]): string[] {
  return normalizeList(tags, MAX_TAGS, MAX_TAG_LENGTH);
}

/** The same normalisation for the `materials` list. */
export function normalizeMaterials(materials: readonly string[]): string[] {
  return normalizeList(materials, MAX_MATERIALS, MAX_MATERIAL_LENGTH);
}

function normalizeList(values: readonly string[], max: number, maxLength: number): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const trimmed = value.trim().slice(0, maxLength);
    const key = trimmed.toLowerCase();
    if (!trimmed || seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
    if (out.length >= max) break;
  }
  return out;
}

export type ParsedPatch = { ok: true; value: BulkListingPatch } | { ok: false; error: string };

function invalid(error: string): ParsedPatch {
  return { ok: false, error };
}

const WHO_MADE_VALUES = WHO_MADE_OPTIONS.map((o) => o.value) as readonly string[];
const PERSONALIZATION_TYPES = PERSONALIZATION_FIELD_TYPES.map((t) => t.value) as readonly string[];

/** A positive-integer field, validated the same way everywhere. */
function positiveInt(raw: Record<string, unknown>, key: string): number | null {
  const value = raw[key];
  return Number.isInteger(value) && (value as number) > 0 ? (value as number) : null;
}

/**
 * Validate and normalise one listing's patch as it arrives from the client.
 * Unlike the publish path's sanitizers, a bad value here is an error rather
 * than a silent drop: the user typed it, and quietly writing something else
 * to their live listing is exactly what this screen must never do.
 */
export function parseBulkPatch(raw: unknown): ParsedPatch {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return invalid("Each edit must be an object.");
  }
  const r = raw as Record<string, unknown>;
  const patch: BulkListingPatch = {};

  if ("title" in r) {
    if (typeof r.title !== "string") return invalid("Title must be text.");
    const title = r.title.trim();
    if (!title) return invalid("Title can't be empty.");
    if (title.length > MAX_TITLE_LENGTH) {
      return invalid(`Title is ${title.length} characters — Etsy's limit is ${MAX_TITLE_LENGTH}.`);
    }
    patch.title = title;
  }

  if ("description" in r) {
    if (typeof r.description !== "string") return invalid("Description must be text.");
    patch.description = r.description;
  }

  if ("tags" in r) {
    if (!Array.isArray(r.tags) || !r.tags.every((t) => typeof t === "string")) {
      return invalid("Tags must be a list of text values.");
    }
    if (r.tags.length > MAX_TAGS) {
      return invalid(`${r.tags.length} tags — Etsy allows at most ${MAX_TAGS}.`);
    }
    const tooLong = (r.tags as string[]).find((t) => t.trim().length > MAX_TAG_LENGTH);
    if (tooLong !== undefined) {
      return invalid(`Tag "${tooLong.trim()}" is longer than ${MAX_TAG_LENGTH} characters.`);
    }
    const tags = normalizeTags(r.tags as string[]);
    // Same reasoning as `shopSectionId` below: Etsy's spec doesn't document
    // how a form-encoded PATCH empties an array field, so emptying one from
    // here is refused out loud instead of sent as a guess.
    if (tags.length === 0) {
      return invalid("Tags can't be emptied from here — keep at least one tag, or clear them on Etsy.");
    }
    patch.tags = tags;
  }

  if ("materials" in r) {
    if (!Array.isArray(r.materials) || !r.materials.every((m) => typeof m === "string")) {
      return invalid("Materials must be a list of text values.");
    }
    const materials = normalizeMaterials(r.materials as string[]);
    if (materials.length === 0) {
      return invalid(
        "Materials can't be emptied from here — keep at least one material, or clear them on Etsy.",
      );
    }
    patch.materials = materials;
  }

  // Etsy's schema states who_made/when_made/is_supply each "Requires" the
  // other two, so the About field is all-or-nothing rather than three
  // independently patchable columns.
  const aboutKeys = ["whoMade", "whenMade", "isSupply"].filter((k) => k in r);
  if (aboutKeys.length > 0) {
    if (aboutKeys.length !== 3) {
      return invalid("About: who made it, what it is and when it was made must be set together.");
    }
    if (typeof r.whoMade !== "string" || !WHO_MADE_VALUES.includes(r.whoMade)) {
      return invalid("About: choose who made this item.");
    }
    if (typeof r.whenMade !== "string" || !(WHEN_MADE_VALUES as readonly string[]).includes(r.whenMade)) {
      return invalid("About: choose when this item was made.");
    }
    if (typeof r.isSupply !== "boolean") {
      return invalid("About: choose whether this is a finished product or a supply.");
    }
    patch.whoMade = r.whoMade;
    patch.whenMade = r.whenMade;
    patch.isSupply = r.isSupply;
  }

  if ("productionPartnerIds" in r) {
    if (!Array.isArray(r.productionPartnerIds)) {
      return invalid("Production partners must be a list.");
    }
    const ids = r.productionPartnerIds.filter((id): id is number => Number.isInteger(id) && id > 0);
    if (ids.length !== r.productionPartnerIds.length) {
      return invalid("Choose valid production partners.");
    }
    patch.productionPartnerIds = ids;
  }

  // Only checkable when the patch carries both halves; the row's current
  // values live on Etsy, so the screen warns about the rest.
  if (patch.whoMade !== undefined && patch.productionPartnerIds !== undefined) {
    const businessError = howItsMadeError({
      whoMade: patch.whoMade as "i_did" | "someone_else" | "collective",
      isSupply: patch.isSupply === true,
      whenMade: patch.whenMade ?? "",
      productionPartnerIds: patch.productionPartnerIds,
    });
    if (businessError) return invalid(businessError);
  }

  if ("taxonomyId" in r) {
    const id = positiveInt(r, "taxonomyId");
    if (id == null) return invalid("Choose a valid category.");
    patch.taxonomyId = id;
  }

  if ("shopSectionId" in r) {
    // Deliberately no "no section" option. Etsy's spec documents the field's
    // default as null but not how a PATCH clears an existing one, and this
    // screen writes to live listings — so only moving a listing *into* a
    // section is offered, rather than guessing at a clearing value.
    const id = positiveInt(r, "shopSectionId");
    if (id == null) return invalid("Choose a valid shop section.");
    patch.shopSectionId = id;
  }

  if ("personalization" in r) {
    const parsed = parsePersonalization(r.personalization);
    if ("error" in parsed) return invalid(parsed.error);
    patch.personalization = parsed.value;
  }

  for (const key of ["shouldAutoRenew", "isTaxable"] as const) {
    if (key in r) {
      if (typeof r[key] !== "boolean") return invalid(`${key} must be true or false.`);
      patch[key] = r[key] as boolean;
    }
  }

  if ("shippingProfileId" in r) {
    const id = positiveInt(r, "shippingProfileId");
    if (id == null) return invalid("Choose a valid shipping profile.");
    patch.shippingProfileId = id;
  }

  if ("returnPolicyId" in r) {
    const id = positiveInt(r, "returnPolicyId");
    if (id == null) return invalid("Choose a valid return policy.");
    patch.returnPolicyId = id;
  }

  if ("readinessStateId" in r) {
    const id = positiveInt(r, "readinessStateId");
    if (id == null) return invalid("Choose a valid processing profile.");
    patch.readinessStateId = id;
  }

  // Etsy: "If set, the value must be greater than 0" — and its spec documents
  // no way to clear one, so 0/null is refused rather than sent as a guess.
  const measurements = [
    ["itemWeight", "Item weight"],
    ["itemLength", "Item length"],
    ["itemWidth", "Item width"],
    ["itemHeight", "Item height"],
  ] as const;
  for (const [key, label] of measurements) {
    if (key in r) {
      const value = r[key];
      if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
        return invalid(`${label} must be greater than 0.`);
      }
      patch[key] = Math.round(value * 100) / 100;
    }
  }
  if ("itemWeightUnit" in r) {
    if (!(WEIGHT_UNITS as readonly string[]).includes(r.itemWeightUnit as string)) {
      return invalid(`Item weight unit must be one of ${WEIGHT_UNITS.join(", ")}.`);
    }
    patch.itemWeightUnit = r.itemWeightUnit as WeightUnit;
  }
  if ("itemDimensionsUnit" in r) {
    if (!(DIMENSION_UNITS as readonly string[]).includes(r.itemDimensionsUnit as string)) {
      return invalid(`Item size unit must be one of ${DIMENSION_UNITS.join(", ")}.`);
    }
    patch.itemDimensionsUnit = r.itemDimensionsUnit as DimensionUnit;
  }
  // Etsy stores a weight and its unit together; sending one without the other
  // would leave the listing describing a number in an unknown unit.
  if (patch.itemWeight !== undefined && patch.itemWeightUnit === undefined) {
    return invalid("Choose a unit for the item weight.");
  }
  if (
    patch.itemDimensionsUnit === undefined &&
    (patch.itemLength !== undefined || patch.itemWidth !== undefined || patch.itemHeight !== undefined)
  ) {
    return invalid("Choose a unit for the item size.");
  }

  if ("price" in r) {
    if (typeof r.price !== "number" || !Number.isFinite(r.price) || r.price <= 0) {
      return invalid("Price must be greater than 0.");
    }
    // Etsy prices carry two decimal places; round rather than reject so a
    // value typed as 12.999 doesn't fail the whole save.
    patch.price = Math.round(r.price * 100) / 100;
  }

  if ("quantity" in r) {
    if (!Number.isInteger(r.quantity) || (r.quantity as number) < 0) {
      return invalid("Quantity must be a whole number of 0 or more.");
    }
    patch.quantity = r.quantity as number;
  }

  if ("sku" in r) {
    if (typeof r.sku !== "string") return invalid("SKU must be text.");
    if (r.sku.length > MAX_SKU_LENGTH) {
      return invalid(`SKU is ${r.sku.length} characters — Etsy's limit is ${MAX_SKU_LENGTH}.`);
    }
    patch.sku = r.sku.trim();
  }

  if ("attributes" in r) {
    const parsed = parseAttributes(r.attributes);
    if ("error" in parsed) return invalid(parsed.error);
    patch.attributes = parsed.value;
  }

  if ("variations" in r) {
    const parsed = parseVariations(r.variations);
    if ("error" in parsed) return invalid(parsed.error);
    patch.variations = parsed.value;
  }

  return { ok: true, value: patch };
}

type Parsed<T> = { value: T } | { error: string };

/**
 * `updateListingProperty` requires both `value_ids` and `values`, and Etsy
 * documents no way to clear a property — so an empty selection is refused
 * here rather than sent as an empty-array guess.
 */
function parseAttributes(raw: unknown): Parsed<BulkAttributeValue[]> {
  if (!Array.isArray(raw)) return { error: "Attributes must be a list." };
  const out: BulkAttributeValue[] = [];
  const seen = new Set<number>();
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") return { error: "Each attribute must be an object." };
    const e = entry as Record<string, unknown>;
    const propertyId = positiveInt(e, "propertyId");
    if (propertyId == null) return { error: "Each attribute needs a valid property." };
    if (seen.has(propertyId)) return { error: `Property ${propertyId} appears twice in one edit.` };
    seen.add(propertyId);

    const valueIds = e.valueIds;
    const values = e.values;
    if (
      !Array.isArray(valueIds) ||
      !Array.isArray(values) ||
      valueIds.length !== values.length ||
      !valueIds.every((v) => Number.isInteger(v) && (v as number) > 0) ||
      !values.every((v) => typeof v === "string")
    ) {
      return { error: "Each attribute needs matching value ids and names." };
    }
    if (valueIds.length === 0) {
      return {
        error:
          "An attribute can't be emptied from here — Etsy's spec documents no way to clear one. Clear it on Etsy instead.",
      };
    }
    const scaleId = e.scaleId;
    out.push({
      propertyId,
      valueIds: valueIds as number[],
      values: values as string[],
      scaleId: Number.isInteger(scaleId) && (scaleId as number) > 0 ? (scaleId as number) : null,
    });
  }
  return { value: out };
}

function parsePersonalization(raw: unknown): Parsed<PersonalizationQuestionInput[]> {
  if (!Array.isArray(raw)) return { error: "Personalization must be a list of questions." };
  const value: PersonalizationQuestionInput[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") {
      return { error: "Personalization: each question must be an object." };
    }
    const q = item as Record<string, unknown>;
    if (typeof q.fieldType !== "string" || !PERSONALIZATION_TYPES.includes(q.fieldType)) {
      return { error: "Personalization: choose a field type for every question." };
    }
    value.push({
      questionId: Number.isInteger(q.questionId) ? (q.questionId as number) : undefined,
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

/**
 * A replacement variation grid. Stricter than the publish path's
 * `sanitizeVariations`, which drops malformed rows: this one writes to a
 * *live* listing, so a grid that doesn't parse cleanly fails the save instead
 * of silently replacing a seller's variations with a partial one.
 */
function parseVariations(raw: unknown): Parsed<BulkVariations> {
  if (!raw || typeof raw !== "object") return { error: "Variations must be an object." };
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r.products) || r.products.length === 0) {
    return {
      error:
        "Variations can't be emptied from here — removing every option would replace the seller's grid. Edit them on Etsy instead.",
    };
  }
  if (r.products.length > MAX_COMBINATIONS_HARD_CAP) {
    return { error: `${r.products.length} combinations exceeds Etsy's limit of ${MAX_COMBINATIONS_HARD_CAP}.` };
  }

  const products: BulkVariationProduct[] = [];
  for (const p of r.products) {
    if (!p || typeof p !== "object") return { error: "Each variation combination must be an object." };
    const entry = p as Record<string, unknown>;
    const pvRaw = entry.propertyValues;
    if (!Array.isArray(pvRaw) || pvRaw.length === 0) {
      return { error: "Each variation combination needs its property values." };
    }
    const propertyValues: BulkVariationProduct["propertyValues"] = [];
    for (const pv of pvRaw) {
      if (!pv || typeof pv !== "object") return { error: "Each variation property must be an object." };
      const v = pv as Record<string, unknown>;
      const propertyId = positiveInt(v, "propertyId");
      const valueIds = v.valueIds;
      const values = v.values;
      if (
        propertyId == null ||
        !Array.isArray(valueIds) ||
        !Array.isArray(values) ||
        valueIds.length === 0 ||
        valueIds.length !== values.length ||
        // null is a free-text value on an otherwise-real Etsy property.
        !valueIds.every((x) => x === null || (Number.isInteger(x) && (x as number) > 0)) ||
        !values.every((x) => typeof x === "string")
      ) {
        return { error: "A variation option is missing its value ids or names." };
      }
      propertyValues.push({
        propertyId,
        name: typeof v.name === "string" && v.name ? v.name : `property #${propertyId}`,
        valueIds: valueIds as (number | null)[],
        values: values as string[],
      });
    }

    const price = entry.price;
    const quantity = entry.quantity;
    const sku = entry.sku;
    const readinessStateId = entry.readinessStateId;
    if (price !== undefined && (typeof price !== "number" || !Number.isFinite(price) || price <= 0)) {
      return { error: "Every variation price must be greater than 0." };
    }
    if (quantity !== undefined && (!Number.isInteger(quantity) || (quantity as number) < 0)) {
      return { error: "Every variation quantity must be a whole number of 0 or more." };
    }
    if (sku !== undefined && typeof sku !== "string") {
      return { error: "Every variation SKU must be text." };
    }
    if (typeof sku === "string" && sku.length > MAX_SKU_LENGTH) {
      return { error: `A variation SKU is longer than Etsy's limit of ${MAX_SKU_LENGTH}.` };
    }

    products.push({
      propertyValues,
      price: typeof price === "number" ? Math.round(price * 100) / 100 : undefined,
      quantity: typeof quantity === "number" ? quantity : undefined,
      sku: typeof sku === "string" && sku.trim() ? sku.trim() : undefined,
      readinessStateId:
        Number.isInteger(readinessStateId) && (readinessStateId as number) > 0
          ? (readinessStateId as number)
          : undefined,
      enabled: entry.enabled !== false,
    });
  }

  const onProperty = (key: string): number[] =>
    Array.isArray(r[key])
      ? (r[key] as unknown[]).filter((x): x is number => Number.isInteger(x) && (x as number) > 0)
      : [];

  return {
    value: {
      products,
      priceOnProperty: onProperty("priceOnProperty"),
      quantityOnProperty: onProperty("quantityOnProperty"),
      skuOnProperty: onProperty("skuOnProperty"),
      readinessStateOnProperty: onProperty("readinessStateOnProperty"),
    },
  };
}

/** One listing's edit, as the save request carries it. */
export interface BulkUpdate {
  listingId: number;
  patch: BulkListingPatch;
}

export type ParsedUpdates = { ok: true; value: BulkUpdate[] } | { ok: false; error: string };

/** How many listings one save request may write. Keeps a single click's Etsy fan-out bounded. */
export const MAX_BULK_UPDATES = 100;

/** Validate the whole `{ updates: [...] }` body of a bulk save. */
export function parseBulkUpdates(raw: unknown): ParsedUpdates {
  if (!Array.isArray(raw)) return { ok: false, error: "`updates` must be an array." };
  if (raw.length === 0) return { ok: false, error: "Nothing to save." };
  if (raw.length > MAX_BULK_UPDATES) {
    return { ok: false, error: `A save can change at most ${MAX_BULK_UPDATES} listings at once.` };
  }

  const value: BulkUpdate[] = [];
  const seen = new Set<number>();
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") return { ok: false, error: "Each edit must be an object." };
    const listingId = (entry as { listingId?: unknown }).listingId;
    if (!Number.isInteger(listingId) || (listingId as number) <= 0) {
      return { ok: false, error: "Each edit needs a valid `listingId`." };
    }
    if (seen.has(listingId as number)) {
      return { ok: false, error: `Listing ${listingId} appears twice in one save.` };
    }
    seen.add(listingId as number);

    const parsed = parseBulkPatch((entry as { patch?: unknown }).patch);
    if (!parsed.ok) return { ok: false, error: parsed.error };
    if (isEmptyPatch(parsed.value)) continue; // nothing targeted at this listing
    value.push({ listingId: listingId as number, patch: parsed.value });
  }

  if (value.length === 0) return { ok: false, error: "Nothing to save." };
  return { ok: true, value };
}
