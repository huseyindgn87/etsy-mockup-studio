/**
 * A listing's inventory record: the price, quantity, SKU and processing
 * profile behind the bulk editor's Inventory group, and the variation grid
 * behind its per-listing Variations cards.
 *
 * None of price/quantity/SKU/processing profile is an `updateListing`
 * parameter — they live on the listing's inventory record, and
 * `PUT /listings/{id}/inventory` replaces the whole product list rather than
 * patching it. So a change is always read-modify-write: fetch the current
 * inventory, change only what the user asked for, send the rest back exactly
 * as it came.
 *
 * {@link updateSimpleInventory} is deliberately limited to listings with a
 * single product (no variations): a variation listing prices and stocks each
 * combination separately, and rewriting that grid from a one-line bulk edit
 * would silently flatten it — it refuses instead, and the caller surfaces why.
 * Editing such a listing on purpose goes through its Variations card, which
 * sends a full grid (see lib/etsy/bulk-apply.ts).
 *
 * Server-only — calls Etsy.
 */

import { etsyFetch } from "@/lib/etsy/auth";
import { EtsyApiError, readEtsyResponse } from "@/lib/etsy/listings";
import { MAX_SKU_LENGTH } from "@/lib/etsy/bulk-edit";

interface RawOffering {
  quantity?: number;
  is_enabled?: boolean;
  is_deleted?: boolean;
  price?: { amount: number; divisor: number; currency_code: string };
  readiness_state_id?: number | null;
}

interface RawPropertyValue {
  property_id: number;
  property_name?: string;
  scale_id?: number | null;
  value_ids?: (number | null)[];
  values?: string[];
}

interface RawProduct {
  sku?: string;
  is_deleted?: boolean;
  offerings?: RawOffering[];
  property_values?: RawPropertyValue[];
}

interface RawInventory {
  products?: RawProduct[];
  price_on_property?: number[];
  quantity_on_property?: number[];
  sku_on_property?: number[];
  readiness_state_on_property?: number[];
}

export interface SimpleInventoryPatch {
  /** Major currency units. */
  price?: number;
  quantity?: number;
  sku?: string;
  /** The processing profile ("readiness state") this listing's offering uses. */
  readinessStateId?: number;
}

/**
 * A listing whose inventory can't be edited from a single row — the caller
 * turns this into the message shown against that listing.
 */
export class VariationInventoryError extends Error {
  constructor() {
    super(
      "This listing prices or stocks each variation separately. Open it in the listing editor to change its inventory.",
    );
    this.name = "VariationInventoryError";
  }
}

function liveProducts(inventory: RawInventory): RawProduct[] {
  return (inventory.products ?? []).filter((p) => !p.is_deleted);
}

/** True when the listing's inventory is a single plain product with no variation properties. */
function isSimple(inventory: RawInventory): boolean {
  const products = liveProducts(inventory);
  if (products.length !== 1) return false;
  if ((products[0].property_values ?? []).length > 0) return false;
  return (
    (inventory.price_on_property ?? []).length === 0 &&
    (inventory.quantity_on_property ?? []).length === 0 &&
    (inventory.sku_on_property ?? []).length === 0
  );
}

async function readInventory(listingId: number): Promise<RawInventory> {
  return (await readEtsyResponse(
    await etsyFetch(`/listings/${listingId}/inventory`),
    `GET /listings/${listingId}/inventory`,
  )) as RawInventory;
}

/**
 * Apply `patch` to a no-variation listing's inventory. Throws
 * {@link VariationInventoryError} when the listing has variations, and lets
 * an {@link EtsyApiError} from either call through to the caller.
 */
export async function updateSimpleInventory(
  listingId: number,
  patch: SimpleInventoryPatch,
): Promise<void> {
  if (
    patch.price === undefined &&
    patch.quantity === undefined &&
    patch.sku === undefined &&
    patch.readinessStateId === undefined
  ) {
    return;
  }

  const inventory = await readInventory(listingId);
  if (!isSimple(inventory)) throw new VariationInventoryError();

  const product = liveProducts(inventory)[0];
  const offerings = (product.offerings ?? []).filter((o) => !o.is_deleted);
  if (offerings.length === 0) {
    throw new EtsyApiError("This listing has no inventory record to update.", 409);
  }

  const sku = patch.sku !== undefined ? patch.sku.slice(0, MAX_SKU_LENGTH) : (product.sku ?? "");
  const requestBody = {
    products: [
      {
        sku: sku || null,
        property_values: [],
        offerings: offerings.map((offering) => {
          const currentPrice =
            offering.price && offering.price.divisor
              ? offering.price.amount / offering.price.divisor
              : 0;
          const readinessStateId = patch.readinessStateId ?? offering.readiness_state_id;
          return {
            price: patch.price ?? currentPrice,
            quantity: patch.quantity ?? Math.max(0, Math.trunc(offering.quantity ?? 0)),
            is_enabled: offering.is_enabled !== false,
            ...(readinessStateId ? { readiness_state_id: readinessStateId } : {}),
          };
        }),
      },
    ],
    // A no-variation listing has no per-property overrides; send them empty so
    // the replace doesn't resurrect stale ones.
    price_on_property: [],
    quantity_on_property: [],
    sku_on_property: [],
    readiness_state_on_property: [],
  };

  await readEtsyResponse(
    await etsyFetch(`/listings/${listingId}/inventory`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestBody),
    }),
    `PUT /listings/${listingId}/inventory`,
    requestBody,
  );
}

// ---------------------------------------------------------------------------
// Reading a variation grid, for the editor's per-listing Variations cards.
// ---------------------------------------------------------------------------

export interface InventoryOption {
  /** Null for a free-text value on an otherwise-real Etsy property. */
  valueId: number | null;
  name: string;
}

export interface InventoryProperty {
  propertyId: number;
  name: string;
  scaleId: number | null;
  /** In the order Etsy's products first mention them — the seller's own order. */
  options: InventoryOption[];
}

export interface InventoryCombination {
  /** The joined value ids — the stable key the card's rows are keyed by. */
  key: string;
  valueIds: (number | null)[];
  values: string[];
  /** Major currency units. */
  price: number | null;
  quantity: number;
  sku: string;
  enabled: boolean;
  readinessStateId: number | null;
}

export interface ListingInventorySnapshot {
  listingId: number;
  properties: InventoryProperty[];
  combinations: InventoryCombination[];
  priceOnProperty: number[];
  quantityOnProperty: number[];
  skuOnProperty: number[];
  readinessStateOnProperty: number[];
}

/** The joined value ids of one combination — matches the editor's own key. */
export function combinationKey(valueIds: (number | null)[], values: string[]): string {
  return valueIds.map((id, i) => (id == null ? `t:${values[i]}` : String(id))).join(":");
}

function snapshotFrom(listingId: number, inventory: RawInventory): ListingInventorySnapshot {
  const products = liveProducts(inventory);

  // Properties and their options, in the order Etsy's own product list
  // mentions them — that's the seller's display order, which the card's drag
  // handles then reorder.
  const properties: InventoryProperty[] = [];
  for (const product of products) {
    for (const pv of product.property_values ?? []) {
      let property = properties.find((p) => p.propertyId === pv.property_id);
      if (!property) {
        property = {
          propertyId: pv.property_id,
          name: pv.property_name ?? `property #${pv.property_id}`,
          scaleId: typeof pv.scale_id === "number" && pv.scale_id > 0 ? pv.scale_id : null,
          options: [],
        };
        properties.push(property);
      }
      const valueIds = pv.value_ids ?? [];
      const values = pv.values ?? [];
      for (let i = 0; i < values.length; i++) {
        const valueId = valueIds[i] ?? null;
        const name = values[i];
        const known = property.options.some((o) =>
          valueId == null ? o.name === name : o.valueId === valueId,
        );
        if (!known) property.options.push({ valueId, name });
      }
    }
  }

  const combinations: InventoryCombination[] = products.map((product) => {
    const valueIds: (number | null)[] = [];
    const values: string[] = [];
    for (const property of properties) {
      const pv = (product.property_values ?? []).find((v) => v.property_id === property.propertyId);
      valueIds.push(pv?.value_ids?.[0] ?? null);
      values.push(pv?.values?.[0] ?? "");
    }
    const offering = (product.offerings ?? []).filter((o) => !o.is_deleted)[0];
    const price =
      offering?.price && offering.price.divisor ? offering.price.amount / offering.price.divisor : null;
    return {
      key: combinationKey(valueIds, values),
      valueIds,
      values,
      price,
      quantity: Math.max(0, Math.trunc(offering?.quantity ?? 0)),
      sku: product.sku ?? "",
      enabled: offering?.is_enabled !== false,
      readinessStateId: offering?.readiness_state_id ?? null,
    };
  });

  return {
    listingId,
    properties,
    combinations,
    priceOnProperty: inventory.price_on_property ?? [],
    quantityOnProperty: inventory.quantity_on_property ?? [],
    skuOnProperty: inventory.sku_on_property ?? [],
    readinessStateOnProperty: inventory.readiness_state_on_property ?? [],
  };
}

/** Matches the write path's fan-out — Etsy's quota is 5 requests/second. */
const READ_CONCURRENCY = 4;

/**
 * Each listing's inventory, keyed by listing id, for the Variations cards.
 * A listing Etsy refuses is simply absent from the map rather than failing
 * the whole read — the card then says it couldn't be loaded.
 */
export async function fetchListingInventories(
  listingIds: number[],
): Promise<Map<number, ListingInventorySnapshot>> {
  const out = new Map<number, ListingInventorySnapshot>();
  let cursor = 0;

  async function worker(): Promise<void> {
    while (cursor < listingIds.length) {
      const listingId = listingIds[cursor++];
      try {
        out.set(listingId, snapshotFrom(listingId, await readInventory(listingId)));
      } catch {
        // left out of the map — the card reports it rather than showing an
        // empty grid that looks like "this listing has no variations".
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(READ_CONCURRENCY, listingIds.length) }, worker));
  return out;
}
