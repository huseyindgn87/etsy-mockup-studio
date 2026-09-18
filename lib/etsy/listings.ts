import { etsyApiKeyHeader, etsyFetch } from "@/lib/etsy/auth";
import { EtsyApiError, etsyRequest } from "@/lib/etsy/client";
import { TtlCache } from "@/lib/etsy/cache";
import { ETSY_ENDPOINTS } from "@/lib/etsy/config";

/**
 * Read helpers for the connected user's Etsy shop listings (API v3).
 *
 * All calls go through {@link etsyFetch}, so they are only usable where the
 * session cookie is writable (Route Handlers / Server Actions).
 */

const SHOP_CACHE_MS = 10 * 60 * 1000; // 10min

export type EtsyListingState =
  | "active"
  | "inactive"
  | "draft"
  | "expired"
  | "sold_out";

export const ETSY_LISTING_STATES: EtsyListingState[] = [
  "active",
  "draft",
  "inactive",
  "sold_out",
  "expired",
];

export interface EtsyListing {
  listingId: number;
  title: string;
  state: string;
  /** Public Etsy URL for the listing. */
  url: string;
  quantity: number;
  /** Localised price string, e.g. "$19.99". Null when the API omits price. */
  price: string | null;
  /** ~570px-wide primary image, or null when the listing has no image yet. */
  thumbnailUrl: string | null;
  /** Expiration time in epoch milliseconds (Etsy sends seconds); null if Etsy omits it (e.g. drafts). */
  endingTimestampMs: number | null;
  /** The shop section this listing is filed under, or null when it's in none. */
  shopSectionId: number | null;
  /** First non-blank SKU string, or null. Not on `getShopListings` — comes from
   * a separate batch inventory call (see {@link fetchSkusForListings}). */
  sku: string | null;
}

export interface ShopListingsPage {
  shopId: number;
  /** Total listings in the shop for the requested state. */
  count: number;
  limit: number;
  offset: number;
  listings: EtsyListing[];
}

export { EtsyApiError, EtsyLimitError } from "@/lib/etsy/client";

/** How much of a non-JSON (or shapeless) error body to keep in the thrown message. */
const ERROR_BODY_PREVIEW_LENGTH = 500;

/**
 * Read an Etsy API v3 response, throwing an {@link EtsyApiError} carrying
 * Etsy's own error text when the call failed. Etsy's error responses are
 * `{ error: string }` (the OpenAPI spec's `ErrorSchema`, on every documented
 * 4xx/5xx) — this reads the raw body first so a response that *isn't* that
 * shape (or isn't JSON at all — Etsy's edge can return an HTML error page)
 * still surfaces its actual text instead of a bare status code.
 *
 * The raw body and, on failure, `requestBody` (pass the exact payload just
 * sent — form fields, JSON, whatever the caller built) are both logged
 * server-side via `console.error`, so a failure is diagnosable from the dev
 * server's own log without reproducing it with a debugger attached.
 *
 * `context` is a short label for the log line, e.g. `"POST /shops/1/listings"`.
 */
export async function readEtsyResponse(
  res: Response,
  context: string,
  requestBody?: unknown,
): Promise<unknown> {
  const text = await res.text();
  let parsed: unknown = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null; // not JSON — `text` itself is still surfaced below
    }
  }

  if (!res.ok) {
    console.error(`[etsy] ${context} -> ${res.status}`, text || "(empty response body)");
    if (requestBody !== undefined) {
      console.error(`[etsy] ${context} request body:`, requestBody);
    }
    const errorField =
      parsed && typeof parsed === "object" && "error" in parsed
        ? (parsed as { error: unknown }).error
        : undefined;
    const detail =
      typeof errorField === "string" && errorField
        ? errorField
        : text
          ? text.slice(0, ERROR_BODY_PREVIEW_LENGTH)
          : `Etsy responded ${res.status} with no error detail.`;
    throw new EtsyApiError(detail, res.status, parsed ?? text);
  }

  return parsed;
}

export interface EtsyPrice {
  amount: number;
  divisor: number;
  currency_code: string;
}

export interface EtsyListingImage {
  url_570xN?: string;
  url_fullxfull?: string;
  url_340x270?: string;
  url_170x135?: string;
  url_75x75?: string;
}

export interface EtsyRawListing {
  listing_id: number;
  title: string;
  state: string;
  url: string;
  quantity: number;
  price?: EtsyPrice;
  images?: EtsyListingImage[];
  ending_timestamp?: number | null;
  shop_section_id?: number | null;
}

export interface EtsyListingsResponse {
  count: number;
  results: EtsyRawListing[];
}

interface EtsyMeResponse {
  user_id: number;
  shop_id: number | null;
}

async function etsyGetJson<T>(path: string): Promise<T> {
  const res = await etsyFetch(path);
  return (await readEtsyResponse(res, `GET ${path}`)) as T;
}

/** Resolve the connected user's shop id. Throws if the account has no shop. */
export async function getShopId(): Promise<number> {
  const me = await etsyGetJson<EtsyMeResponse>("/users/me");
  if (!me.shop_id) {
    throw new EtsyApiError(
      "This Etsy account is not linked to a shop yet.",
      404,
    );
  }
  return me.shop_id;
}

interface EtsyShopResponse {
  shop_id: number;
  shop_name: string;
  currency_code?: string;
}

const shopSummaryCache = new TtlCache<number, { shopName: string; currencyCode: string | null }>(SHOP_CACHE_MS);

/** The connected user's shop name and currency, for display (e.g. the listing editor header and prices). */
export async function getShopSummary(): Promise<{ shopName: string; currencyCode: string | null }> {
  const shopId = await getShopId();
  return shopSummaryCache.get(shopId, async () => {
    const shop = await etsyGetJson<EtsyShopResponse>(`/shops/${shopId}`);
    return { shopName: shop.shop_name, currencyCode: shop.currency_code || null };
  });
}

/** The connected user's shop name, for display (e.g. the listing editor header). */
export async function getShopName(): Promise<string> {
  return (await getShopSummary()).shopName;
}

export interface ShopInfo {
  etsyUserId: string;
  shopId: string;
  shopName: string;
  shopIconUrl: string | null;
}

/**
 * Look up the shop tied to a raw access token, calling Etsy directly with
 * that token rather than the stored session cookie. Needed at two points
 * that happen *before* a cookie session exists to read from: the OAuth
 * callback (recording a new `EtsyShopConnection`) and a shop switch
 * (confirming which shop a freshly-minted token set belongs to).
 */
export async function fetchShopInfoForToken(accessToken: string): Promise<ShopInfo> {
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    "x-api-key": etsyApiKeyHeader(),
  };

  const meRes = await etsyRequest(`${ETSY_ENDPOINTS.apiBase}/users/me`, { headers });
  const me = (await readEtsyResponse(meRes, "GET /users/me")) as EtsyMeResponse;
  if (!me.shop_id) {
    throw new EtsyApiError("This Etsy account is not linked to a shop yet.", 404);
  }

  const shopRes = await etsyRequest(`${ETSY_ENDPOINTS.apiBase}/shops/${me.shop_id}`, { headers });
  const shop = (await readEtsyResponse(shopRes, "GET /shops/:id")) as EtsyShopResponse & {
    icon_url_fullxfull?: string;
  };

  return {
    etsyUserId: String(me.user_id),
    shopId: String(me.shop_id),
    shopName: shop.shop_name,
    shopIconUrl: shop.icon_url_fullxfull ?? null,
  };
}

const HTML_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

/**
 * Etsy listing titles can come back HTML-escaped (e.g. `I&#39;d Rather...`,
 * `&gt;&gt;SALE&lt;&lt;`) — decodes the common named/numeric entities.
 * Server-side (no DOM available here, unlike the client-side decode already
 * used for shop-section titles in `ListingForm.tsx`).
 */
export function decodeHtmlEntities(s: string): string {
  if (!s.includes("&")) return s;
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
    if (entity[0] === "#") {
      const code =
        entity[1] === "x" || entity[1] === "X"
          ? Number.parseInt(entity.slice(2), 16)
          : Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    const lower = entity.toLowerCase();
    return lower in HTML_ENTITIES ? HTML_ENTITIES[lower] : match;
  });
}

export function formatPrice(price?: EtsyPrice): string | null {
  if (!price || typeof price.amount !== "number" || !price.divisor) return null;
  const value = price.amount / price.divisor;
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: price.currency_code,
    }).format(value);
  } catch {
    return `${value.toFixed(2)} ${price.currency_code}`;
  }
}

export function pickThumbnail(images?: EtsyListingImage[]): string | null {
  const first = images?.[0];
  if (!first) return null;
  return (
    first.url_570xN ??
    first.url_340x270 ??
    first.url_fullxfull ??
    first.url_170x135 ??
    first.url_75x75 ??
    null
  );
}

function mapListing(raw: EtsyRawListing): EtsyListing {
  return {
    listingId: raw.listing_id,
    title: decodeHtmlEntities(raw.title),
    state: raw.state,
    url: raw.url,
    quantity: raw.quantity ?? 0,
    price: formatPrice(raw.price),
    thumbnailUrl: pickThumbnail(raw.images),
    endingTimestampMs:
      typeof raw.ending_timestamp === "number" ? raw.ending_timestamp * 1000 : null,
    shopSectionId:
      typeof raw.shop_section_id === "number" && raw.shop_section_id > 0
        ? raw.shop_section_id
        : null,
    sku: null, // filled in by fetchSkusForListings after the initial map
  };
}

/** Etsy's cap on `listing_ids` per `/listings/batch/inventory` call. */
const SKU_BATCH_LIMIT = 100;

export interface EtsyInventoryBatchResponse {
  count: number;
  results?: Array<{ listing_id: number; skus?: string[] }>;
}

const SKU_CACHE_MS = 60 * 1000; // 1min — matches LISTINGS_CACHE_MS below
const skuCache = new TtlCache<string, Map<number, string | null>>(SKU_CACHE_MS);

/**
 * SKUs aren't part of the regular shop-listings response — only the batch
 * inventory endpoint returns them (as a top-level `skus` array per listing).
 * Fetches in chunks of {@link SKU_BATCH_LIMIT} and takes the first non-blank
 * SKU string per listing; listings with none map to `null`.
 */
async function fetchSkusForListings(listingIds: number[]): Promise<Map<number, string | null>> {
  if (listingIds.length === 0) return new Map();
  const sorted = [...new Set(listingIds)].sort((a, b) => a - b);
  const cacheKey = sorted.join(",");

  return skuCache.get(cacheKey, async () => {
    const chunks: number[][] = [];
    for (let i = 0; i < sorted.length; i += SKU_BATCH_LIMIT) {
      chunks.push(sorted.slice(i, i + SKU_BATCH_LIMIT));
    }

    const pages = await Promise.all(
      chunks.map((chunk) =>
        etsyGetJson<EtsyInventoryBatchResponse>(
          `/listings/batch/inventory?listing_ids=${chunk.join(",")}`,
        ),
      ),
    );

    const map = new Map<number, string | null>();
    for (const page of pages) {
      for (const r of page.results ?? []) {
        map.set(r.listing_id, (r.skus ?? []).find((s) => s.trim().length > 0) ?? null);
      }
    }
    return map;
  });
}

/** Mutates `listings` in place, filling in each `sku` from a batched lookup. */
async function attachSkus(listings: EtsyListing[]): Promise<void> {
  const skuByListingId = await fetchSkusForListings(listings.map((l) => l.listingId));
  for (const listing of listings) {
    listing.sku = skuByListingId.get(listing.listingId) ?? null;
  }
}

export interface FetchShopListingsOptions {
  state?: EtsyListingState;
  limit?: number;
  offset?: number;
}

/**
 * Listing pages change more often than shop-level config (sections,
 * processing profiles) but still don't need every click to burn a fresh
 * quota-metered call — a short TTL keeps repeat page/filter views (and the
 * per-state sidebar counts, which are just `limit:1` calls to this same
 * function) instant without going far stale. Etsy's quota is 5 req/s;
 * `etsyFetch`'s own retry-with-backoff handles any 429 regardless.
 */
const LISTINGS_CACHE_MS = 60 * 1000; // 1min
const listingsPageCache = new TtlCache<string, ShopListingsPage>(LISTINGS_CACHE_MS);

/**
 * Fetch one page of the connected user's shop listings (newest first) with the
 * primary image included.
 */
export async function fetchShopListings(
  options: FetchShopListingsOptions = {},
): Promise<ShopListingsPage> {
  const state = options.state ?? "active";
  const limit = Math.min(Math.max(Math.trunc(options.limit ?? 24), 1), 100);
  const offset = Math.max(Math.trunc(options.offset ?? 0), 0);

  const shopId = await getShopId();
  const cacheKey = `${shopId}:${state}:${limit}:${offset}`;

  return listingsPageCache.get(cacheKey, async () => {
    const query = new URLSearchParams({
      state,
      limit: String(limit),
      offset: String(offset),
      sort_on: "created",
      sort_order: "desc",
      includes: "Images",
    });

    const data = await etsyGetJson<EtsyListingsResponse>(
      `/shops/${shopId}/listings?${query.toString()}`,
    );

    const listings = (data.results ?? []).map(mapListing);
    await attachSkus(listings);

    return {
      shopId,
      count: data.count ?? 0,
      limit,
      offset,
      listings,
    };
  });
}

/**
 * The connected shop's listing count for every state, for the listings
 * page's sidebar filters. One `limit:1` call per state (their `count` is the
 * whole-state total regardless of `limit`) — shares `fetchShopListings`'s
 * own cache, so this and the currently-selected state's real page fetch
 * never double up on the same request.
 */
export async function getShopListingStateCounts(): Promise<Record<EtsyListingState, number>> {
  const entries = await Promise.all(
    ETSY_LISTING_STATES.map(async (state) => {
      const page = await fetchShopListings({ state, limit: 1, offset: 0 });
      return [state, page.count] as const;
    }),
  );
  return Object.fromEntries(entries) as Record<EtsyListingState, number>;
}

/** Etsy's per-request page cap. */
const MAX_PAGE = 100;
/** How many pages to fetch in parallel once we know the total count. */
const FETCH_ALL_CONCURRENCY = 4;
/** Defensive cap so a runaway shop/count doesn't loop forever. */
const FETCH_ALL_SAFETY_CAP = 20_000;

export interface FetchAllShopListingsOptions {
  state?: EtsyListingState;
}

/**
 * Fetch every one of the connected user's listings for `state` (default
 * "active"), paging until Etsy's reported `count` is exhausted.
 *
 * Etsy's shop-scoped search (`findAllActiveListingsByShop`) ranks by
 * relevance across title/tags/materials/description, not a literal title
 * match — searching "miami" can surface listings that never say "miami"
 * anywhere in the title. So title search is done ourselves, client-side,
 * over this full list, rather than trusting Etsy's search endpoint.
 */
const fetchAllCache = new TtlCache<string, ShopListingsPage>(LISTINGS_CACHE_MS);

export async function fetchAllShopListings(
  options: FetchAllShopListingsOptions = {},
): Promise<ShopListingsPage> {
  const state = options.state ?? "active";
  const shopId = await getShopId();

  return fetchAllCache.get(`${shopId}:${state}`, async () => {
    const fetchPage = async (offset: number): Promise<{ count: number; listings: EtsyListing[] }> => {
      const query = new URLSearchParams({
        state,
        limit: String(MAX_PAGE),
        offset: String(offset),
        sort_on: "created",
        sort_order: "desc",
        includes: "Images",
      });
      const data = await etsyGetJson<EtsyListingsResponse>(
        `/shops/${shopId}/listings?${query.toString()}`,
      );
      return { count: data.count ?? 0, listings: (data.results ?? []).map(mapListing) };
    };

    const first = await fetchPage(0);
    const total = Math.min(first.count, FETCH_ALL_SAFETY_CAP);
    const pages = new Map<number, EtsyListing[]>([[0, first.listings]]);

    const remainingOffsets: number[] = [];
    for (let offset = MAX_PAGE; offset < total; offset += MAX_PAGE) remainingOffsets.push(offset);

    let cursor = 0;
    async function worker(): Promise<void> {
      while (cursor < remainingOffsets.length) {
        const offset = remainingOffsets[cursor++];
        pages.set(offset, (await fetchPage(offset)).listings);
      }
    }
    await Promise.all(
      Array.from({ length: Math.min(FETCH_ALL_CONCURRENCY, remainingOffsets.length) }, worker),
    );

    // pages resolve out of order under concurrency — reassemble by offset
    const listings = [...pages.keys()]
      .sort((a, b) => a - b)
      .flatMap((offset) => pages.get(offset)!);
    await attachSkus(listings);

    return { shopId, count: first.count, limit: listings.length, offset: 0, listings };
  });
}
