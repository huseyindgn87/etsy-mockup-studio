/**
 * Per-value variation photos on a listing that already exists on Etsy.
 *
 * `POST /shops/{shop}/listings/{listing}/variation-images` overwrites the
 * listing's whole set, so a save always sends the complete set the editor
 * shows — an empty one clears them. Etsy takes images on one property only,
 * refers to values by the ids its own inventory holds, and every image must
 * already be on the listing. Assignments carry the value's name so they can be
 * matched to the inventory Etsy returns after a grid replace, where free-text
 * values (and possibly others) get new ids.
 *
 * Server-only — calls Etsy.
 */

import { etsyFetch } from "@/lib/etsy/auth";
import type { BulkVariationImage } from "@/lib/etsy/bulk-edit";
import type { VariationImageInput } from "@/lib/etsy/listing-create";
import { liveProducts, type RawInventory } from "@/lib/etsy/listing-inventory";
import { readEtsyResponse } from "@/lib/etsy/listings";

/** One value's photo, as the bulk editor sends it. */
export type VariationImageAssignment = BulkVariationImage;

/** A listing's current variation photos, as Etsy reports them. */
export interface ListingVariationImage {
  propertyId: number;
  valueId: number;
  value: string;
  imageId: number;
}

export type ResolvedVariationImages = { ok: true; images: VariationImageInput[] } | { ok: false; error: string };

/**
 * The request body for a set of assignments, against the inventory as it is
 * now (the PUT's response when the grid was just replaced). A value is found
 * by name first, then by its old id only if that id is still in the
 * inventory. Refuses the whole set — rather than dropping entries, which
 * would silently clear those photos — when the assignments span more than
 * one property, a value or property is gone, a value is given two photos, or
 * a photo isn't on the listing.
 */
export function resolveVariationImages(
  assignments: readonly VariationImageAssignment[],
  inventory: RawInventory,
  listingImageIds: readonly number[],
): ResolvedVariationImages {
  const propertyIds = new Set(assignments.map((a) => a.propertyId));
  if (propertyIds.size > 1) {
    return { ok: false, error: "Photos can vary by one variation only." };
  }

  const properties = new Map<number, { byName: Map<string, number>; ids: Set<number> }>();
  for (const product of liveProducts(inventory)) {
    for (const pv of product.property_values ?? []) {
      let property = properties.get(pv.property_id);
      if (!property) {
        property = { byName: new Map(), ids: new Set() };
        properties.set(pv.property_id, property);
      }
      const values = pv.values ?? [];
      const ids = pv.value_ids ?? [];
      values.forEach((name, i) => {
        const id = ids[i];
        if (typeof id !== "number" || !Number.isInteger(id) || id <= 0) return;
        property.ids.add(id);
        const key = name.trim().toLowerCase();
        if (!property.byName.has(key)) property.byName.set(key, id);
      });
    }
  }

  const imageIds = new Set(listingImageIds);
  const images: VariationImageInput[] = [];
  const chosen = new Map<number, number>();
  for (const a of assignments) {
    const property = properties.get(a.propertyId);
    if (!property) return { ok: false, error: `“${a.value}” belongs to a variation the listing no longer has.` };
    const valueId =
      property.byName.get(a.value.trim().toLowerCase()) ??
      (a.valueId != null && property.ids.has(a.valueId) ? a.valueId : undefined);
    if (valueId == null) return { ok: false, error: `“${a.value}” is no longer an option on the listing.` };
    if (!imageIds.has(a.imageId)) {
      return { ok: false, error: `The photo chosen for “${a.value}” is no longer on the listing.` };
    }
    const earlier = chosen.get(valueId);
    if (earlier === a.imageId) continue;
    if (earlier != null) return { ok: false, error: `“${a.value}” was given two photos.` };
    chosen.set(valueId, a.imageId);
    images.push({ propertyId: a.propertyId, valueId, imageId: a.imageId });
  }
  return { ok: true, images };
}

/** `GET /listings/{listing}/images` — the ids of the photos on the listing now. */
export async function readListingImageIds(listingId: number): Promise<number[]> {
  const body = (await readEtsyResponse(
    await etsyFetch(`/listings/${listingId}/images`),
    `GET /listings/${listingId}/images`,
  )) as { results?: { listing_image_id?: unknown }[] } | null;
  return (body?.results ?? [])
    .map((r) => r.listing_image_id)
    .filter((id): id is number => typeof id === "number" && Number.isInteger(id) && id > 0);
}

/** `GET /shops/{shop}/listings/{listing}/variation-images`. */
export async function readVariationImages(shopId: number, listingId: number): Promise<ListingVariationImage[]> {
  const body = (await readEtsyResponse(
    await etsyFetch(`/shops/${shopId}/listings/${listingId}/variation-images`),
    `GET /shops/${shopId}/listings/${listingId}/variation-images`,
  )) as { results?: { property_id?: unknown; value_id?: unknown; value?: unknown; image_id?: unknown }[] } | null;
  const positive = (x: unknown): x is number => typeof x === "number" && Number.isInteger(x) && x > 0;
  return (body?.results ?? []).flatMap((r) =>
    positive(r.property_id) && positive(r.value_id) && positive(r.image_id)
      ? [{ propertyId: r.property_id, valueId: r.value_id, value: typeof r.value === "string" ? r.value : "", imageId: r.image_id }]
      : [],
  );
}

const READ_CONCURRENCY = 4;

/**
 * Each listing's variation photos. A listing Etsy refuses is left out, so the
 * editor can tell "none" from "couldn't be read" and not offer to overwrite
 * photos it never saw.
 */
export async function fetchVariationImages(
  shopId: number,
  listingIds: number[],
): Promise<Map<number, ListingVariationImage[]>> {
  const out = new Map<number, ListingVariationImage[]>();
  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < listingIds.length) {
      const listingId = listingIds[cursor++];
      try {
        out.set(listingId, await readVariationImages(shopId, listingId));
      } catch {
        // left out of the map
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(READ_CONCURRENCY, listingIds.length) }, worker));
  return out;
}
