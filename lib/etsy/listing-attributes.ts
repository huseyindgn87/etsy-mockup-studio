/**
 * Reads the category attributes ("listing properties") currently set on a set
 * of listings — `GET /shops/{shop}/listings/{listing}/properties`.
 *
 * Etsy has no batch form of this endpoint, so it's one call per listing. The
 * bulk editor therefore only asks for it when the Optional group is opened,
 * rather than on load, and the fan-out is capped the same way writes are.
 *
 * Read-only: nothing here writes (see memory `live-listing-never-auto-modified`).
 * Server-only — calls Etsy.
 */

import { etsyFetch } from "@/lib/etsy/auth";
import { readEtsyResponse } from "@/lib/etsy/listings";

/** One property as Etsy has it set on a listing. */
export interface ListingAttribute {
  propertyId: number;
  propertyName: string;
  scaleId: number | null;
  valueIds: number[];
  values: string[];
}

interface RawProperty {
  property_id?: number;
  property_name?: string;
  scale_id?: number | null;
  value_ids?: number[];
  values?: string[];
}

function mapAttribute(raw: RawProperty): ListingAttribute | null {
  if (!Number.isInteger(raw.property_id) || (raw.property_id as number) <= 0) return null;
  return {
    propertyId: raw.property_id as number,
    propertyName: raw.property_name ?? "",
    scaleId: typeof raw.scale_id === "number" && raw.scale_id > 0 ? raw.scale_id : null,
    valueIds: Array.isArray(raw.value_ids) ? raw.value_ids.filter((v) => Number.isInteger(v)) : [],
    values: Array.isArray(raw.values) ? raw.values.filter((v) => typeof v === "string") : [],
  };
}

/** Matches the write path's fan-out — Etsy's quota is 5 requests/second. */
const READ_CONCURRENCY = 4;

/**
 * Every listing's current attributes, keyed by listing id. A listing Etsy
 * refuses (or that simply has none) comes back as an empty list rather than
 * failing the whole read — the editor shows what it could load.
 */
export async function fetchListingAttributes(
  shopId: number,
  listingIds: number[],
): Promise<Map<number, ListingAttribute[]>> {
  const out = new Map<number, ListingAttribute[]>();
  let cursor = 0;

  async function worker(): Promise<void> {
    while (cursor < listingIds.length) {
      const listingId = listingIds[cursor++];
      try {
        const data = (await readEtsyResponse(
          await etsyFetch(`/shops/${shopId}/listings/${listingId}/properties`),
          `GET /shops/${shopId}/listings/${listingId}/properties`,
        )) as { results?: RawProperty[] };
        out.set(
          listingId,
          (data.results ?? []).map(mapAttribute).filter((a): a is ListingAttribute => a != null),
        );
      } catch {
        out.set(listingId, []);
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(READ_CONCURRENCY, listingIds.length) }, worker),
  );
  return out;
}
