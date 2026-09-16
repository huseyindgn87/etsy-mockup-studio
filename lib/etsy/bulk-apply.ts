/**
 * Writes one bulk edit to Etsy, per listing.
 *
 * This is the only place bulk editing touches a live listing, and it runs
 * exclusively from the explicit save (`POST /api/etsy/listings/bulk/save`) —
 * opening the bulk editor, selecting rows and typing changes never reach it
 * (see memory `live-listing-never-auto-modified`).
 *
 * One patch can need up to five Etsy calls, applied in this order:
 *   1. `updateListing`          — the plain listing fields
 *   2. the inventory record     — price/quantity/SKU/processing profile, or a
 *                                 full variation grid when the Variations card
 *                                 was edited (never both: a grid already
 *                                 carries the per-combination values)
 *   3. `updateListingProperty`  — one call per Optional-group attribute
 *   4. the personalization resource
 * One listing failing never stops the others — each gets its own result, so a
 * save that half-succeeds reports exactly which listings changed.
 *
 * Server-only — calls Etsy.
 */

import { etsyFetch } from "@/lib/etsy/auth";
import { splitPatch, type BulkListingPatch, type BulkUpdate, type BulkVariations } from "@/lib/etsy/bulk-edit";
import { setListingProperty, updateListingInventory, updateListingPersonalization } from "@/lib/etsy/listing-create";
import { updateSimpleInventory, VariationInventoryError } from "@/lib/etsy/listing-inventory";
import { EtsyApiError, readEtsyResponse } from "@/lib/etsy/listings";

/** What one listing's write did. `ok: false` carries the message shown against that row. */
export interface BulkResult {
  listingId: number;
  ok: boolean;
  error?: string;
}

function errorMessage(err: unknown): string {
  if (err instanceof VariationInventoryError) return err.message;
  if (err instanceof EtsyApiError) return err.message;
  return err instanceof Error ? err.message : "Etsy rejected the change.";
}

/** The `updateListing` form body for the listing-side half of a patch. */
export function listingUpdateForm(patch: BulkListingPatch): URLSearchParams {
  const form = new URLSearchParams();
  if (patch.title !== undefined) form.set("title", patch.title);
  if (patch.description !== undefined) form.set("description", patch.description);
  if (patch.tags !== undefined) {
    // Repeated params, the same way createDraftListing sends tags. Never
    // empty — an empty list is refused in `parseBulkPatch`.
    for (const tag of patch.tags) form.append("tags", tag);
  }
  if (patch.materials !== undefined) {
    for (const material of patch.materials) form.append("materials", material);
  }
  // Etsy's schema has who_made/when_made/is_supply each requiring the other
  // two; `parseBulkPatch` guarantees they arrive together.
  if (patch.whoMade !== undefined) form.set("who_made", patch.whoMade);
  if (patch.whenMade !== undefined) form.set("when_made", patch.whenMade);
  if (patch.isSupply !== undefined) form.set("is_supply", String(patch.isSupply));
  if (patch.productionPartnerIds !== undefined) {
    for (const id of patch.productionPartnerIds) form.append("production_partner_ids", String(id));
  }
  if (patch.taxonomyId !== undefined) form.set("taxonomy_id", String(patch.taxonomyId));
  if (patch.shopSectionId !== undefined) form.set("shop_section_id", String(patch.shopSectionId));
  if (patch.shouldAutoRenew !== undefined) form.set("should_auto_renew", String(patch.shouldAutoRenew));
  if (patch.isTaxable !== undefined) form.set("is_taxable", String(patch.isTaxable));
  if (patch.shippingProfileId !== undefined) {
    form.set("shipping_profile_id", String(patch.shippingProfileId));
  }
  if (patch.returnPolicyId !== undefined) form.set("return_policy_id", String(patch.returnPolicyId));
  if (patch.itemWeight !== undefined) form.set("item_weight", String(patch.itemWeight));
  if (patch.itemWeightUnit !== undefined) form.set("item_weight_unit", patch.itemWeightUnit);
  if (patch.itemLength !== undefined) form.set("item_length", String(patch.itemLength));
  if (patch.itemWidth !== undefined) form.set("item_width", String(patch.itemWidth));
  if (patch.itemHeight !== undefined) form.set("item_height", String(patch.itemHeight));
  if (patch.itemDimensionsUnit !== undefined) {
    form.set("item_dimensions_unit", patch.itemDimensionsUnit);
  }
  return form;
}

/**
 * `PATCH /shops/{shop}/listings/{listing}` with just the fields this patch
 * changes. A PATCH, so fields left out keep their current values.
 */
async function updateListingFields(
  shopId: number,
  listingId: number,
  patch: BulkListingPatch,
): Promise<void> {
  const form = listingUpdateForm(patch);
  if ([...form.keys()].length === 0) return;

  await readEtsyResponse(
    await etsyFetch(`/shops/${shopId}/listings/${listingId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    }),
    `PATCH /shops/${shopId}/listings/${listingId}`,
    form.toString(),
  );
}

/**
 * Replace a listing's variation grid. Every combination Etsy requires is
 * already in `products` (the editor sends the whole grid it was showing), and
 * a price or quantity the user left alone falls back to the listing's own
 * current value rather than to an invented default.
 */
async function writeVariationGrid(
  listingId: number,
  variations: BulkVariations,
  fallback: { price?: number; quantity?: number },
): Promise<void> {
  await updateListingInventory(listingId, {
    products: variations.products.map((p) => ({
      sku: p.sku,
      propertyValues: p.propertyValues,
      price: p.price ?? fallback.price ?? 1,
      quantity: p.quantity ?? fallback.quantity ?? 0,
      readinessStateId: p.readinessStateId,
      enabled: p.enabled,
    })),
    priceOnProperty: variations.priceOnProperty,
    quantityOnProperty: variations.quantityOnProperty,
    skuOnProperty: variations.skuOnProperty,
    readinessStateOnProperty: variations.readinessStateOnProperty,
  });
}

/** Apply one listing's patch. Never throws — a failure comes back as `ok: false`. */
export async function applyBulkUpdate(shopId: number, update: BulkUpdate): Promise<BulkResult> {
  const { listing, inventory, attributes, personalization, variations } = splitPatch(update.patch);
  try {
    await updateListingFields(shopId, update.listingId, listing);

    if (variations) {
      // A grid replace already carries every combination's own price,
      // quantity and SKU — sending the single-product write as well would
      // immediately flatten what was just written.
      await writeVariationGrid(update.listingId, variations, {
        price: inventory.price,
        quantity: inventory.quantity,
      });
    } else {
      await updateSimpleInventory(update.listingId, inventory);
    }

    for (const attribute of attributes) {
      await setListingProperty(shopId, update.listingId, attribute);
    }

    if (personalization) {
      await updateListingPersonalization(shopId, update.listingId, personalization);
    }

    return { listingId: update.listingId, ok: true };
  } catch (err) {
    return { listingId: update.listingId, ok: false, error: errorMessage(err) };
  }
}

/**
 * How many listings are written at once. Etsy's quota is 5 requests/second
 * and one listing can cost several calls (update + inventory read + write +
 * one per attribute), so this stays well under it; `etsyFetch` still retries
 * any 429 on top.
 */
const WRITE_CONCURRENCY = 2;

/** Apply every update, a couple at a time, in the order given. */
export async function applyBulkUpdates(
  shopId: number,
  updates: BulkUpdate[],
): Promise<BulkResult[]> {
  const results = new Array<BulkResult>(updates.length);
  let cursor = 0;

  async function worker(): Promise<void> {
    while (cursor < updates.length) {
      const index = cursor++;
      results[index] = await applyBulkUpdate(shopId, updates[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(WRITE_CONCURRENCY, updates.length) }, worker));
  return results;
}

/**
 * `DELETE /listings/{listing}` — permanent, and the one bulk action Etsy
 * can't undo. Requires the `listings_d` OAuth scope, which is NOT part of
 * this app's default scope string (lib/etsy/config.ts): without it Etsy
 * answers 403 and the message is surfaced against the row.
 */
export async function deleteEtsyListing(listingId: number): Promise<void> {
  await readEtsyResponse(
    await etsyFetch(`/listings/${listingId}`, { method: "DELETE" }),
    `DELETE /listings/${listingId}`,
  );
}

/** Delete every listing, reporting per listing. Never throws. */
export async function deleteEtsyListings(listingIds: number[]): Promise<BulkResult[]> {
  const results: BulkResult[] = [];
  for (const listingId of listingIds) {
    try {
      await deleteEtsyListing(listingId);
      results.push({ listingId, ok: true });
    } catch (err) {
      results.push({ listingId, ok: false, error: errorMessage(err) });
    }
  }
  return results;
}
