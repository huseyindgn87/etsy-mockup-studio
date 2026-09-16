/**
 * Reads the current values of the fields the bulk editor edits, for a set of
 * listings at once (`GET /listings/batch?listing_ids=...`, 100 ids per call).
 *
 * The DB-backed listings cache (lib/etsy/listing-store.ts) only holds what the
 * listings *table* shows — it has no description, tags, shipping profile or
 * renewal flag — so opening the bulk editor reads those from Etsy directly.
 * Read-only: nothing here writes (see memory `live-listing-never-auto-modified`).
 */

import { etsyFetch } from "@/lib/etsy/auth";
import { decodeHtmlEntities, pickThumbnail, readEtsyResponse, type EtsyListingImage } from "@/lib/etsy/listings";

/** Etsy's cap on `listing_ids` per `/listings/batch` call. */
const BATCH_LIMIT = 100;

/** One listing as the bulk editor loads it. */
export interface BulkListingDetail {
  listingId: number;
  title: string;
  description: string;
  tags: string[];
  state: string;
  url: string;
  thumbnailUrl: string | null;
  shopSectionId: number | null;
  shippingProfileId: number | null;
  shouldAutoRenew: boolean;
  isTaxable: boolean;
  /** Major currency units, or null when Etsy omits the price. */
  price: number | null;
  quantity: number;
  sku: string;
  /**
   * Variation listings price and stock each combination separately, so a
   * single price/quantity/SKU can't be written to them — the editor shows
   * their Inventory fields as read-only and the save route refuses them.
   */
  hasVariations: boolean;
}

interface RawBatchListing {
  listing_id: number;
  title?: string;
  description?: string;
  tags?: string[];
  state?: string;
  url?: string;
  images?: EtsyListingImage[];
  shop_section_id?: number | null;
  shipping_profile_id?: number | null;
  should_auto_renew?: boolean;
  is_taxable?: boolean;
  price?: { amount: number; divisor: number; currency_code: string };
  quantity?: number;
  skus?: string[];
  has_variations?: boolean;
}

function mapDetail(raw: RawBatchListing): BulkListingDetail {
  return {
    listingId: raw.listing_id,
    title: decodeHtmlEntities(raw.title ?? ""),
    description: decodeHtmlEntities(raw.description ?? ""),
    tags: Array.isArray(raw.tags) ? raw.tags : [],
    state: raw.state ?? "",
    url: raw.url ?? "",
    thumbnailUrl: pickThumbnail(raw.images),
    shopSectionId:
      typeof raw.shop_section_id === "number" && raw.shop_section_id > 0 ? raw.shop_section_id : null,
    shippingProfileId:
      typeof raw.shipping_profile_id === "number" && raw.shipping_profile_id > 0
        ? raw.shipping_profile_id
        : null,
    shouldAutoRenew: raw.should_auto_renew === true,
    isTaxable: raw.is_taxable !== false,
    price: raw.price && raw.price.divisor ? raw.price.amount / raw.price.divisor : null,
    quantity: typeof raw.quantity === "number" ? raw.quantity : 0,
    sku: (raw.skus ?? []).find((s) => s.trim().length > 0) ?? "",
    hasVariations: raw.has_variations === true,
  };
}

/**
 * Load `listingIds` in batches, in the order asked for. Ids Etsy doesn't
 * return (deleted since the last refresh, or never this shop's) are simply
 * absent from the result — the caller decides what to say about them.
 */
export async function fetchListingDetails(listingIds: number[]): Promise<BulkListingDetail[]> {
  const unique = [...new Set(listingIds)];
  if (unique.length === 0) return [];

  const chunks: number[][] = [];
  for (let i = 0; i < unique.length; i += BATCH_LIMIT) {
    chunks.push(unique.slice(i, i + BATCH_LIMIT));
  }

  const pages = await Promise.all(
    chunks.map(async (chunk) => {
      const query = new URLSearchParams({ listing_ids: chunk.join(","), includes: "Images" });
      const res = await etsyFetch(`/listings/batch?${query.toString()}`);
      const data = (await readEtsyResponse(res, "GET /listings/batch")) as {
        results?: RawBatchListing[];
      };
      return data.results ?? [];
    }),
  );

  const byId = new Map<number, BulkListingDetail>();
  for (const page of pages) {
    for (const raw of page) byId.set(raw.listing_id, mapDetail(raw));
  }
  // Preserve the caller's order — the bulk editor lists rows in the order they
  // were selected, and batches resolve concurrently.
  return unique.map((id) => byId.get(id)).filter((d): d is BulkListingDetail => d != null);
}
