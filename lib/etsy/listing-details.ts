/**
 * Reads the current values of the fields the bulk editor edits, for a set of
 * listings at once (`GET /listings/batch?listing_ids=...`, 100 ids per call).
 *
 * The DB-backed listings cache (lib/etsy/listing-store.ts) only holds what the
 * listings *table* shows — it has no description, tags, shipping profile or
 * renewal flag — so opening the bulk editor reads those from Etsy directly.
 * Read-only: nothing here writes (see memory `live-listing-never-auto-modified`).
 *
 * Images, videos and personalization arrive as associations on the same call
 * (`includes`), so the Media and Personalization sections cost no extra
 * requests. Category attributes and the variation grid are NOT available as
 * batch associations — they're one call per listing each and are loaded
 * on demand instead (lib/etsy/listing-attributes.ts, lib/etsy/listing-inventory.ts).
 */

import { etsyFetch } from "@/lib/etsy/auth";
import { decodeHtmlEntities, pickThumbnail, readEtsyResponse, type EtsyListingImage } from "@/lib/etsy/listings";
import type { PersonalizationQuestionInput } from "@/lib/etsy/listing-personalization";
import type { DimensionUnit, WeightUnit } from "@/lib/etsy/bulk-edit";

/** Etsy's cap on `listing_ids` per `/listings/batch` call. */
const BATCH_LIMIT = 100;

export interface BulkListingImage {
  imageId: number;
  url: string;
  rank: number;
  altText: string;
}

export interface BulkListingVideo {
  videoId: number;
  thumbnailUrl: string;
  videoUrl: string;
  state: string;
}

/** One listing as the bulk editor loads it. */
export interface BulkListingDetail {
  listingId: number;
  title: string;
  description: string;
  tags: string[];
  materials: string[];
  state: string;
  url: string;
  thumbnailUrl: string | null;
  shopSectionId: number | null;
  shippingProfileId: number | null;
  returnPolicyId: number | null;
  /**
   * Etsy returns `readiness_state_id` only on shop-scoped or single-listing
   * reads, so on this batch endpoint it is often null even when the listing
   * has one. The editor shows "not loaded" rather than claiming it's unset.
   */
  readinessStateId: number | null;
  taxonomyId: number | null;
  whoMade: string;
  whenMade: string;
  isSupply: boolean;
  productionPartnerIds: number[];
  itemWeight: number | null;
  itemWeightUnit: WeightUnit | null;
  itemLength: number | null;
  itemWidth: number | null;
  itemHeight: number | null;
  itemDimensionsUnit: DimensionUnit | null;
  shouldAutoRenew: boolean;
  isTaxable: boolean;
  /** Major currency units, or null when Etsy omits the price. */
  price: number | null;
  quantity: number;
  sku: string;
  images: BulkListingImage[];
  videos: BulkListingVideo[];
  personalizationQuestions: PersonalizationQuestionInput[];
  /**
   * Variation listings price and stock each combination separately, so a
   * single price/quantity/SKU can't be written to them — the editor shows
   * their Inventory fields as read-only and the save route refuses them.
   */
  hasVariations: boolean;
}

interface RawPersonalizationQuestion {
  question_id?: number;
  question_text?: string;
  instructions?: string;
  question_type?: string;
  required?: boolean;
  max_allowed_characters?: number;
  max_allowed_files?: number;
  options?: { label?: string }[];
}

interface RawBatchListing {
  listing_id: number;
  title?: string;
  description?: string;
  tags?: string[];
  materials?: string[];
  state?: string;
  url?: string;
  images?: EtsyListingImage[];
  videos?: {
    video_id?: number;
    thumbnail_url?: string;
    video_url?: string;
    video_state?: string;
  }[];
  personalization?: { personalization_questions?: RawPersonalizationQuestion[] };
  production_partners?: { production_partner_id?: number }[];
  shop_section_id?: number | null;
  shipping_profile_id?: number | null;
  return_policy_id?: number | null;
  readiness_state_id?: number | null;
  taxonomy_id?: number | null;
  who_made?: string;
  when_made?: string;
  is_supply?: boolean;
  item_weight?: number | null;
  item_weight_unit?: string | null;
  item_length?: number | null;
  item_width?: number | null;
  item_height?: number | null;
  item_dimensions_unit?: string | null;
  should_auto_renew?: boolean;
  is_taxable?: boolean;
  price?: { amount: number; divisor: number; currency_code: string };
  quantity?: number;
  skus?: string[];
  has_variations?: boolean;
}

const positiveOrNull = (value: unknown): number | null =>
  typeof value === "number" && value > 0 ? value : null;

/** Etsy's image list, sorted the way it displays them. */
function mapImages(raw: EtsyListingImage[] | undefined): BulkListingImage[] {
  const images = (raw ?? []) as (EtsyListingImage & {
    listing_image_id?: number;
    rank?: number;
    alt_text?: string;
    url_570xN?: string;
    url_fullxfull?: string;
    url_170x135?: string;
  })[];
  return images
    .map((img) => ({
      imageId: img.listing_image_id ?? 0,
      url: img.url_570xN ?? img.url_fullxfull ?? img.url_170x135 ?? "",
      rank: typeof img.rank === "number" ? img.rank : 0,
      altText: img.alt_text ?? "",
    }))
    .filter((img) => img.url)
    .sort((a, b) => a.rank - b.rank);
}

/** Maps Etsy's stored personalization back into the shape the editor edits. */
function mapPersonalization(raw: RawBatchListing["personalization"]): PersonalizationQuestionInput[] {
  const questions = raw?.personalization_questions ?? [];
  return questions
    .filter((q) => typeof q.question_type === "string")
    .map((q) => ({
      questionId: Number.isInteger(q.question_id) ? q.question_id : undefined,
      questionText: q.question_text ?? "",
      instructions: q.instructions ?? "",
      required: q.required === true,
      fieldType: q.question_type as PersonalizationQuestionInput["fieldType"],
      maxAllowedCharacters: q.max_allowed_characters ?? 50,
      maxAllowedFiles: q.max_allowed_files ?? 1,
      options: (q.options ?? []).map((o) => o.label ?? "").filter(Boolean),
    }));
}

function mapDetail(raw: RawBatchListing): BulkListingDetail {
  return {
    listingId: raw.listing_id,
    title: decodeHtmlEntities(raw.title ?? ""),
    description: decodeHtmlEntities(raw.description ?? ""),
    tags: Array.isArray(raw.tags) ? raw.tags : [],
    materials: Array.isArray(raw.materials) ? raw.materials : [],
    state: raw.state ?? "",
    url: raw.url ?? "",
    thumbnailUrl: pickThumbnail(raw.images),
    shopSectionId: positiveOrNull(raw.shop_section_id),
    shippingProfileId: positiveOrNull(raw.shipping_profile_id),
    returnPolicyId: positiveOrNull(raw.return_policy_id),
    readinessStateId: positiveOrNull(raw.readiness_state_id),
    taxonomyId: positiveOrNull(raw.taxonomy_id),
    whoMade: raw.who_made ?? "",
    whenMade: raw.when_made ?? "",
    isSupply: raw.is_supply === true,
    productionPartnerIds: (raw.production_partners ?? [])
      .map((p) => p.production_partner_id)
      .filter((id): id is number => Number.isInteger(id) && (id as number) > 0),
    itemWeight: positiveOrNull(raw.item_weight),
    itemWeightUnit: (raw.item_weight_unit || null) as WeightUnit | null,
    itemLength: positiveOrNull(raw.item_length),
    itemWidth: positiveOrNull(raw.item_width),
    itemHeight: positiveOrNull(raw.item_height),
    itemDimensionsUnit: (raw.item_dimensions_unit || null) as DimensionUnit | null,
    shouldAutoRenew: raw.should_auto_renew === true,
    isTaxable: raw.is_taxable !== false,
    price: raw.price && raw.price.divisor ? raw.price.amount / raw.price.divisor : null,
    quantity: typeof raw.quantity === "number" ? raw.quantity : 0,
    sku: (raw.skus ?? []).find((s) => s.trim().length > 0) ?? "",
    images: mapImages(raw.images),
    videos: (raw.videos ?? [])
      .filter((v) => Number.isInteger(v.video_id))
      .map((v) => ({
        videoId: v.video_id as number,
        thumbnailUrl: v.thumbnail_url ?? "",
        videoUrl: v.video_url ?? "",
        state: v.video_state ?? "",
      })),
    personalizationQuestions: mapPersonalization(raw.personalization),
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
      const query = new URLSearchParams({
        listing_ids: chunk.join(","),
        includes: "Images,Videos,Personalization",
        // Etsy's own note on this parameter: needed to enable the newer
        // response values related to processing profiles.
        legacy: "true",
      });
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
