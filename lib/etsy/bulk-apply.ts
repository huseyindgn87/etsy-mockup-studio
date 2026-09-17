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
 *   3. `updateVariationImages`  — the photo per variation value. After the
 *                                 grid, because a replace can give values new
 *                                 ids: they're re-resolved from the inventory
 *                                 that write returned (or a fresh read)
 *   4. `updateListingProperty`  — one call per Optional-group attribute
 *   5. the personalization resource
 * One listing failing never stops the others — each gets its own result, so a
 * save that half-succeeds reports exactly which listings changed. Variation
 * photos failing after everything else landed is reported as `partial`:
 * nothing is rolled back.
 *
 * Server-only — calls Etsy.
 */

import { etsyFetch } from "@/lib/etsy/auth";
import { joinIdList, joinList } from "@/lib/etsy/form-list";
import { confirmedListingFields, type ConfirmedListingFields } from "@/lib/etsy/listing-confirmed";
import {
  splitPatch,
  type BulkListingPatch,
  type BulkUpdate,
  type BulkVariationImage,
  type BulkVariations,
} from "@/lib/etsy/bulk-edit";
import {
  setListingProperty,
  updateListingInventory,
  updateListingPersonalization,
  updateVariationImages,
} from "@/lib/etsy/listing-create";
import {
  readInventory,
  updateSimpleInventory,
  VariationInventoryError,
  type RawInventory,
} from "@/lib/etsy/listing-inventory";
import { EtsyApiError, readEtsyResponse } from "@/lib/etsy/listings";
import { readListingImageIds, resolveVariationImages } from "@/lib/etsy/variation-images";

/**
 * What one listing's write did. `ok: false` carries the message shown against
 * that row; `partial` means everything but the variation photos was saved.
 */
export interface BulkResult {
  listingId: number;
  ok: boolean;
  partial?: boolean;
  error?: string;
  /**
   * The listing fields as Etsy's update response reported them. The caller
   * shows and caches these instead of the patch it sent, so a value Etsy
   * stored differently from what was asked can't be displayed as saved.
   * Absent when the patch touched no listing-side field, or when the response
   * wasn't a listing.
   */
  confirmed?: ConfirmedListingFields;
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
  // One comma-joined field per list, never repeated params: Etsy documents
  // these as "a comma-separated list" and its urlencoded parser keeps only
  // the LAST occurrence of a repeated key, so `tags=a&tags=b&tags=c` silently
  // left the listing with just "c". Never empty — `parseBulkPatch` refuses an
  // empty list, and the values themselves can't contain a comma (Etsy's own
  // regexes allow only letters, numbers, whitespace and -'™©® in a tag, and
  // letters, numbers and whitespace in a material).
  if (patch.tags !== undefined) form.set("tags", joinList(patch.tags));
  if (patch.materials !== undefined) form.set("materials", joinList(patch.materials));
  // Etsy's schema has who_made/when_made/is_supply each requiring the other
  // two; `parseBulkPatch` guarantees they arrive together.
  if (patch.whoMade !== undefined) form.set("who_made", patch.whoMade);
  if (patch.whenMade !== undefined) form.set("when_made", patch.whenMade);
  if (patch.isSupply !== undefined) form.set("is_supply", String(patch.isSupply));
  if (patch.productionPartnerIds !== undefined) {
    form.set("production_partner_ids", joinIdList(patch.productionPartnerIds));
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
 * changes. A PATCH, so fields left out keep their current values. Etsy
 * answers with the whole updated listing, which is what the caller reports as
 * saved — never the patch it sent.
 */
async function updateListingFields(
  shopId: number,
  listingId: number,
  patch: BulkListingPatch,
): Promise<ConfirmedListingFields | null> {
  const form = listingUpdateForm(patch);
  if ([...form.keys()].length === 0) return null;

  const body = await readEtsyResponse(
    await etsyFetch(`/shops/${shopId}/listings/${listingId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    }),
    `PATCH /shops/${shopId}/listings/${listingId}`,
    form.toString(),
  );
  return confirmedListingFields(body);
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
): Promise<RawInventory> {
  return (await updateListingInventory(listingId, {
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
  })) as RawInventory;
}

/**
 * Send the listing's full set of variation photos, resolved against
 * `inventory` and the photos on the listing now. Throws with the reason when
 * the set can't be sent as it is.
 */
async function writeVariationImages(
  shopId: number,
  listingId: number,
  assignments: BulkVariationImage[],
  inventory: RawInventory,
): Promise<void> {
  const imageIds = assignments.length > 0 ? await readListingImageIds(listingId) : [];
  const resolved = resolveVariationImages(assignments, inventory, imageIds);
  if (!resolved.ok) throw new Error(resolved.error);
  await updateVariationImages(shopId, listingId, resolved.images);
}

/** Apply one listing's patch. Never throws — a failure comes back as `ok: false`. */
export async function applyBulkUpdate(shopId: number, update: BulkUpdate): Promise<BulkResult> {
  const { listing, inventory, attributes, personalization, variations, variationImages } = splitPatch(update.patch);
  let imagesError: string | null = null;
  let confirmed: ConfirmedListingFields | null = null;
  try {
    confirmed = await updateListingFields(shopId, update.listingId, listing);

    let saved: RawInventory | null = null;
    if (variations) {
      // A grid replace already carries every combination's own price,
      // quantity and SKU — sending the single-product write as well would
      // immediately flatten what was just written.
      saved = await writeVariationGrid(update.listingId, variations, {
        price: inventory.price,
        quantity: inventory.quantity,
      });
    } else {
      await updateSimpleInventory(update.listingId, inventory);
    }

    if (variationImages) {
      try {
        // Clearing needs no ids; otherwise resolve against the inventory as it is now.
        const current =
          saved?.products || variationImages.length === 0 ? (saved ?? {}) : await readInventory(update.listingId);
        await writeVariationImages(shopId, update.listingId, variationImages, current);
      } catch (err) {
        imagesError = errorMessage(err);
      }
    }

    for (const attribute of attributes) {
      await setListingProperty(shopId, update.listingId, attribute);
    }

    if (personalization) {
      await updateListingPersonalization(shopId, update.listingId, personalization);
    }

    if (imagesError != null) {
      return {
        listingId: update.listingId,
        ok: false,
        partial: true,
        error: `Variation photos: ${imagesError}`,
        ...(confirmed ? { confirmed } : {}),
      };
    }
    return { listingId: update.listingId, ok: true, ...(confirmed ? { confirmed } : {}) };
  } catch (err) {
    const error = errorMessage(err);
    // The listing PATCH may have landed before a later step threw, so what
    // Etsy confirmed is still reported — the row is wrong either way without it.
    return {
      listingId: update.listingId,
      ok: false,
      error: imagesError == null ? error : `${error}; Variation photos: ${imagesError}`,
      ...(confirmed ? { confirmed } : {}),
    };
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
