/**
 * Writes one bulk edit to Etsy, per listing.
 *
 * This is the only place bulk editing touches a live listing, and it runs
 * exclusively from the explicit save (`POST /api/etsy/listings/bulk/save`) —
 * opening the bulk editor, selecting rows and typing changes never reach it
 * (see memory `live-listing-never-auto-modified`).
 *
 * A patch can need two different Etsy writes: `updateListing` for the listing
 * fields, and the inventory record for price/quantity/SKU (see
 * lib/etsy/listing-inventory.ts). They're applied in that order, and one
 * listing failing never stops the others — each gets its own result, so a
 * save that half-succeeds reports exactly which listings changed.
 *
 * Server-only — calls Etsy.
 */

import { etsyFetch } from "@/lib/etsy/auth";
import { splitPatch, type BulkListingPatch, type BulkUpdate } from "@/lib/etsy/bulk-edit";
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
  if (patch.shopSectionId !== undefined) form.set("shop_section_id", String(patch.shopSectionId));
  if (patch.shouldAutoRenew !== undefined) form.set("should_auto_renew", String(patch.shouldAutoRenew));
  if (patch.isTaxable !== undefined) form.set("is_taxable", String(patch.isTaxable));
  if (patch.shippingProfileId !== undefined) {
    form.set("shipping_profile_id", String(patch.shippingProfileId));
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

/** Apply one listing's patch. Never throws — a failure comes back as `ok: false`. */
export async function applyBulkUpdate(shopId: number, update: BulkUpdate): Promise<BulkResult> {
  const { listing, inventory } = splitPatch(update.patch);
  try {
    await updateListingFields(shopId, update.listingId, listing);
    await updateSimpleInventory(update.listingId, inventory);
    return { listingId: update.listingId, ok: true };
  } catch (err) {
    return { listingId: update.listingId, ok: false, error: errorMessage(err) };
  }
}

/**
 * How many listings are written at once. Etsy's quota is 5 requests/second
 * and one listing can cost three calls (update + inventory read + write), so
 * this stays well under it; `etsyFetch` still retries any 429 on top.
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
