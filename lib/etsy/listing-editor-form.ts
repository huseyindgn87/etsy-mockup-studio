/**
 * Turns a listing as this app knows it — the cached `Listing` row with its
 * inventory grid, or the same fields read live from Etsy — into the value the
 * single-listing editor (`ListingForm`) edits.
 *
 * Pure and dependency-free (types only), so the loader, the API route and the
 * editor's tests all share it.
 */

import type { ListingFormValue, VariationToggleKey } from "@/app/(app)/mockups/ListingForm";
import { WHEN_MADE_VALUES, WHO_MADE_OPTIONS, type WhenMade, type WhoMade } from "@/lib/etsy/listing-classification";
import type { ListingAttribute } from "@/lib/etsy/listing-attributes";
import type { InventoryCombination, ListingInventorySnapshot } from "@/lib/etsy/listing-inventory";
import type { PersonalizationQuestionInput } from "@/lib/etsy/listing-personalization";

/** Etsy's reserved "Custom Variation" property ids — matches `ListingForm`. */
const CUSTOM_PROPERTY_IDS = [513, 514, 516];
const MAX_VARIATIONS = 3;
const TOGGLE_KEYS: VariationToggleKey[] = ["price", "readiness", "quantity", "sku"];

/** Everything the editor form needs, whichever source it came from. */
export interface EditorListingSource {
  title: string;
  description: string;
  tags: string[];
  materials: string[];
  /** Major currency units. */
  price: number | null;
  quantity: number;
  sku: string;
  shopSectionId: number | null;
  readinessStateId: number | null;
  shippingProfileId: number | null;
  returnPolicyId: number | null;
  whoMade: string | null;
  whenMade: string | null;
  isSupply: boolean;
  productionPartnerIds: number[];
  taxonomyId: number | null;
  taxonomyPath: string;
  attributes: ListingAttribute[];
  personalizationQuestions: PersonalizationQuestionInput[];
  featured: boolean;
  autoRenew: boolean;
  inventory: ListingInventorySnapshot | null;
}

/** The cached `Listing` row with its inventory grid, as Prisma returns it. */
export interface CachedListingRow {
  listingId: string;
  title: string;
  description: string | null;
  tags: string[];
  materials: string[];
  quantity: number;
  sku: string | null;
  shopSectionId: number | null;
  shippingProfileId: string | null;
  returnPolicyId: string | null;
  whoMade: string | null;
  whenMade: string | null;
  isSupply: boolean | null;
  priceAmount: number | null;
  priceDivisor: number | null;
  isPersonalizable: boolean;
  personalizationIsRequired: boolean;
  personalizationInstructions: string | null;
  personalizationCharCountMax: number | null;
  inventoryProperties: {
    etsyPropertyId: string;
    name: string;
    scaleId: string | null;
    rank: number;
    priceOnProperty: boolean;
    quantityOnProperty: boolean;
    skuOnProperty: boolean;
    values: { id: string; etsyValueId: string | null; value: string; rank: number }[];
  }[];
  inventoryProducts: {
    sku: string | null;
    priceAmount: number;
    priceDivisor: number;
    quantity: number;
    isEnabled: boolean;
    readinessStateId: string | null;
    values: { valueId: string }[];
  }[];
}

const positiveId = (raw: string | number | null | undefined): number | null => {
  const n = typeof raw === "number" ? raw : Number(raw);
  return raw != null && Number.isSafeInteger(n) && n > 0 ? n : null;
};

/** The cached grid in the same shape a live `GET /listings/{id}/inventory` read maps to. */
export function inventoryFromCache(row: CachedListingRow): ListingInventorySnapshot | null {
  if (row.inventoryProducts.length === 0) return null;
  const properties = [...row.inventoryProperties].sort((a, b) => a.rank - b.rank);
  const valueById = new Map<string, { propertyIndex: number; valueId: number | null; name: string }>();
  properties.forEach((p, propertyIndex) => {
    for (const v of p.values) valueById.set(v.id, { propertyIndex, valueId: positiveId(v.etsyValueId), name: v.value });
  });

  const combinations: InventoryCombination[] = row.inventoryProducts.map((product) => {
    const valueIds: (number | null)[] = properties.map(() => null);
    const values: string[] = properties.map(() => "");
    for (const link of product.values) {
      const v = valueById.get(link.valueId);
      if (!v) continue;
      valueIds[v.propertyIndex] = v.valueId;
      values[v.propertyIndex] = v.name;
    }
    return {
      key: valueIds.map((id, i) => (id == null ? `t:${values[i]}` : String(id))).join(":"),
      valueIds,
      values,
      price: product.priceDivisor ? product.priceAmount / product.priceDivisor : null,
      quantity: product.quantity,
      sku: product.sku ?? "",
      enabled: product.isEnabled,
      readinessStateId: positiveId(product.readinessStateId),
    };
  });

  const on = (flag: "priceOnProperty" | "quantityOnProperty" | "skuOnProperty") =>
    properties.filter((p) => p[flag]).map((p) => Number(p.etsyPropertyId));

  return {
    listingId: Number(row.listingId),
    properties: properties.map((p) => ({
      propertyId: Number(p.etsyPropertyId),
      name: p.name,
      scaleId: positiveId(p.scaleId),
      options: [...p.values].sort((a, b) => a.rank - b.rank).map((v) => ({ valueId: positiveId(v.etsyValueId), name: v.value })),
    })),
    combinations,
    priceOnProperty: on("priceOnProperty"),
    quantityOnProperty: on("quantityOnProperty"),
    skuOnProperty: on("skuOnProperty"),
    // Not cached — inferred from the combinations in `listingFormFromSource`.
    readinessStateOnProperty: [],
  };
}

/** The cached row's own fields; what the cache doesn't hold is left empty for the caller to fill. */
export function sourceFromCache(row: CachedListingRow): EditorListingSource {
  return {
    title: row.title,
    description: row.description ?? "",
    tags: row.tags,
    materials: row.materials,
    price: row.priceAmount != null && row.priceDivisor ? row.priceAmount / row.priceDivisor : null,
    quantity: row.quantity,
    sku: row.sku ?? "",
    shopSectionId: row.shopSectionId,
    readinessStateId: null,
    shippingProfileId: positiveId(row.shippingProfileId),
    returnPolicyId: positiveId(row.returnPolicyId),
    whoMade: row.whoMade,
    whenMade: row.whenMade,
    isSupply: row.isSupply === true,
    productionPartnerIds: [],
    taxonomyId: null,
    taxonomyPath: "",
    attributes: [],
    personalizationQuestions: row.isPersonalizable
      ? [
          {
            questionText: "Personalization",
            instructions: row.personalizationInstructions ?? "",
            required: row.personalizationIsRequired,
            fieldType: "text_input",
            maxAllowedCharacters: row.personalizationCharCountMax ?? 50,
            maxAllowedFiles: 1,
            options: [],
          },
        ]
      : [],
    featured: false,
    autoRenew: true,
    inventory: inventoryFromCache(row),
  };
}

const distinct = <T>(items: T[]): T[] => [...new Set(items)];

/** The fewest variation indices `pick` depends on — a single one if it varies by just that, else all. */
function inferAppliesTo(combos: InventoryCombination[], count: number, pick: (c: InventoryCombination) => unknown): number[] {
  if (distinct(combos.map(pick)).length <= 1) return [];
  for (let i = 0; i < count; i++) {
    const seen = new Map<string, unknown>();
    const consistent = combos.every((c) => {
      const k = String(c.valueIds[i] ?? c.values[i]);
      if (seen.has(k)) return seen.get(k) === pick(c);
      seen.set(k, pick(c));
      return true;
    });
    if (consistent) return [i];
  }
  return Array.from({ length: count }, (_, i) => i);
}

export function listingFormFromSource(src: EditorListingSource): ListingFormValue {
  const whoMade = WHO_MADE_OPTIONS.some((o) => o.value === src.whoMade) ? (src.whoMade as WhoMade) : "i_did";
  const whenMade = (WHEN_MADE_VALUES as readonly string[]).includes(src.whenMade ?? "")
    ? (src.whenMade as WhenMade)
    : "made_to_order";

  const properties: ListingFormValue["properties"] = {};
  for (const a of src.attributes) {
    if (a.valueIds.length === 0 && a.values.length === 0) continue;
    properties[a.propertyId] = { name: a.propertyName, valueIds: a.valueIds, values: a.values, scaleId: a.scaleId };
  }

  const inventory = src.inventory;
  const combos = inventory?.combinations ?? [];
  const first = combos.find((c) => c.enabled) ?? combos[0];
  const dims = (inventory?.properties ?? []).slice(0, MAX_VARIATIONS);

  // Each option's form id: its Etsy value id, or a synthetic negative one for a free-text value.
  const formIds = dims.map((p) => {
    let synthetic = 0;
    return p.options.map((o) => o.valueId ?? --synthetic);
  });
  const formValueIds = (c: InventoryCombination): number[] =>
    dims.map((p, i) => {
      const idx = p.options.findIndex((o) => (c.valueIds[i] == null ? o.name === c.values[i] : o.valueId === c.valueIds[i]));
      return idx >= 0 ? formIds[i][idx] : 0;
    });

  const variationToggles = {} as ListingFormValue["variationToggles"];
  const variationRows = {} as ListingFormValue["variationRows"];
  for (const key of TOGGLE_KEYS) {
    variationToggles[key] = { enabled: false, appliesTo: [] };
    variationRows[key] = {};
  }
  const variationRowEnabled: Record<string, boolean> = {};

  if (dims.length > 0 && inventory) {
    const indicesOf = (propertyIds: number[]) =>
      dims.map((p, i) => (propertyIds.includes(p.propertyId) ? i : -1)).filter((i) => i >= 0);
    const appliesTo: Record<VariationToggleKey, number[]> = {
      price: indicesOf(inventory.priceOnProperty),
      quantity: indicesOf(inventory.quantityOnProperty),
      sku: indicesOf(inventory.skuOnProperty),
      readiness:
        inventory.readinessStateOnProperty.length > 0
          ? indicesOf(inventory.readinessStateOnProperty)
          : inferAppliesTo(combos, dims.length, (c) => c.readinessStateId),
    };
    const cell: Record<VariationToggleKey, (c: InventoryCombination) => string> = {
      price: (c) => (c.price != null ? c.price.toFixed(2) : ""),
      quantity: (c) => String(c.quantity),
      sku: (c) => c.sku,
      readiness: (c) => (c.readinessStateId != null ? String(c.readinessStateId) : ""),
    };
    for (const key of TOGGLE_KEYS) {
      if (appliesTo[key].length === 0) continue;
      variationToggles[key] = { enabled: true, appliesTo: appliesTo[key] };
    }
    for (const c of combos) {
      const ids = formValueIds(c);
      for (const key of TOGGLE_KEYS) {
        if (!variationToggles[key].enabled) continue;
        const cellKey = variationToggles[key].appliesTo.map((i) => ids[i]).join(":");
        if (!(cellKey in variationRows[key])) variationRows[key][cellKey] = cell[key](c);
      }
      if (!c.enabled) variationRowEnabled[ids.join(":")] = false;
    }
  }

  const price = src.price ?? first?.price ?? null;
  const readiness = distinct(combos.map((c) => c.readinessStateId).filter((id): id is number => id != null));

  return {
    title: src.title,
    description: src.description,
    tags: src.tags,
    materials: src.materials,
    taxonomyId: src.taxonomyId,
    taxonomyPath: src.taxonomyPath,
    shopSectionId: src.shopSectionId,
    shopSectionTitle: "",
    properties,
    price: price != null ? price.toFixed(2) : "",
    quantity: String(first?.quantity ?? src.quantity),
    sku: first?.sku || src.sku,
    readinessStateId: src.readinessStateId ?? (readiness.length > 0 ? readiness[0] : null),
    shippingProfileId: src.shippingProfileId,
    returnPolicyId: src.returnPolicyId,
    whoMade,
    isSupply: src.isSupply,
    whenMade,
    productionPartnerIds: src.productionPartnerIds,
    personalizationQuestions: src.personalizationQuestions,
    variations: dims.map((p, i) => ({
      propertyId: p.propertyId,
      name: p.name,
      isCustom: CUSTOM_PROPERTY_IDS.includes(p.propertyId),
      valueIds: formIds[i],
      values: p.options.map((o) => o.name),
      linksPhotos: false,
      ...(p.scaleId != null ? { scaleId: p.scaleId } : {}),
    })),
    variationToggles,
    variationRows,
    variationRowEnabled,
    variationPhotos: {},
    featureListing: src.featured,
    promoteWithAds: false,
    autoRenew: src.autoRenew,
  };
}
