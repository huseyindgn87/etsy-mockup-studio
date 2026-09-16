/**
 * Price, quantity and SKU edits for a listing with no variations.
 *
 * None of the three is an `updateListing` parameter — they live on the
 * listing's inventory record, and `PUT /listings/{id}/inventory` replaces the
 * whole product list rather than patching it. So a change here is always
 * read-modify-write: fetch the current inventory, change only what the user
 * asked for, send the rest back exactly as it came.
 *
 * Deliberately limited to listings with a single product (no variations).
 * A variation listing prices and stocks each combination separately, and
 * rewriting that grid from a one-line bulk edit would silently flatten it —
 * {@link updateSimpleInventory} refuses instead, and the caller surfaces why.
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

interface RawProduct {
  sku?: string;
  is_deleted?: boolean;
  offerings?: RawOffering[];
  property_values?: {
    property_id: number;
    property_name?: string;
    scale_id?: number | null;
    value_ids?: number[];
    values?: string[];
  }[];
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

/**
 * Apply `patch` to a no-variation listing's inventory. Throws
 * {@link VariationInventoryError} when the listing has variations, and lets
 * an {@link EtsyApiError} from either call through to the caller.
 */
export async function updateSimpleInventory(
  listingId: number,
  patch: SimpleInventoryPatch,
): Promise<void> {
  if (patch.price === undefined && patch.quantity === undefined && patch.sku === undefined) return;

  const inventory = (await readEtsyResponse(
    await etsyFetch(`/listings/${listingId}/inventory`),
    `GET /listings/${listingId}/inventory`,
  )) as RawInventory;

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
          return {
            price: patch.price ?? currentPrice,
            quantity: patch.quantity ?? Math.max(0, Math.trunc(offering.quantity ?? 0)),
            is_enabled: offering.is_enabled !== false,
            ...(offering.readiness_state_id
              ? { readiness_state_id: offering.readiness_state_id }
              : {}),
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
