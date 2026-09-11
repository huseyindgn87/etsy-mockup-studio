import { etsyFetch } from "@/lib/etsy/auth";

/**
 * Read helpers for the connected user's Etsy shop listings (API v3).
 *
 * All calls go through {@link etsyFetch}, so they are only usable where the
 * session cookie is writable (Route Handlers / Server Actions).
 */

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
}

export interface ShopListingsPage {
  shopId: number;
  /** Total listings in the shop for the requested state. */
  count: number;
  limit: number;
  offset: number;
  listings: EtsyListing[];
}

export class EtsyApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = "EtsyApiError";
  }
}

interface EtsyPrice {
  amount: number;
  divisor: number;
  currency_code: string;
}

interface EtsyListingImage {
  url_570xN?: string;
  url_fullxfull?: string;
  url_340x270?: string;
  url_170x135?: string;
  url_75x75?: string;
}

interface EtsyRawListing {
  listing_id: number;
  title: string;
  state: string;
  url: string;
  quantity: number;
  price?: EtsyPrice;
  images?: EtsyListingImage[];
}

interface EtsyListingsResponse {
  count: number;
  results: EtsyRawListing[];
}

interface EtsyMeResponse {
  user_id: number;
  shop_id: number | null;
}

async function etsyGetJson<T>(path: string): Promise<T> {
  const res = await etsyFetch(path);
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    // Surface the raw Etsy error body in the dev server logs — its `error`
    // string is the only reliable way to tell scope vs. app-approval vs.
    // ownership failures apart.
    console.error(
      `[etsy] GET ${path} -> ${res.status}`,
      typeof body === "string" ? body : JSON.stringify(body),
    );
    throw new EtsyApiError(
      `Etsy API responded ${res.status} for ${path}`,
      res.status,
      body,
    );
  }
  return body as T;
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

function formatPrice(price?: EtsyPrice): string | null {
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

function pickThumbnail(images?: EtsyListingImage[]): string | null {
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
    title: raw.title,
    state: raw.state,
    url: raw.url,
    quantity: raw.quantity ?? 0,
    price: formatPrice(raw.price),
    thumbnailUrl: pickThumbnail(raw.images),
  };
}

export interface FetchShopListingsOptions {
  state?: EtsyListingState;
  limit?: number;
  offset?: number;
}

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

  return {
    shopId,
    count: data.count ?? 0,
    limit,
    offset,
    listings: (data.results ?? []).map(mapListing),
  };
}

export interface SearchShopListingsOptions {
  keywords: string;
  limit?: number;
  offset?: number;
}

interface EtsyListingIdsResponse {
  count: number;
  results: { listing_id: number }[];
}

/**
 * Keyword-search the connected user's ACTIVE listings by title/tags/etc.
 * (`findAllActiveListingsByShop` — the only shop-scoped search Etsy exposes;
 * `getListingsByShop` has no keyword filter). A shop can have thousands of
 * listings, so this is the only viable way to find one without paging
 * through everything client-side.
 *
 * Two calls: the search endpoint returns matching ids but no images (it
 * doesn't support `includes`); a batch lookup then fetches images for just
 * that page of ids. Relevance order from the search is preserved.
 */
export async function searchShopListings(
  options: SearchShopListingsOptions,
): Promise<ShopListingsPage> {
  const keywords = options.keywords.trim();
  const limit = Math.min(Math.max(Math.trunc(options.limit ?? 24), 1), 100);
  const offset = Math.max(Math.trunc(options.offset ?? 0), 0);
  const shopId = await getShopId();

  if (!keywords) return fetchShopListings({ state: "active", limit, offset });

  const searchQuery = new URLSearchParams({
    keywords,
    limit: String(limit),
    offset: String(offset),
    sort_on: "score",
  });
  const found = await etsyGetJson<EtsyListingIdsResponse>(
    `/shops/${shopId}/listings/active?${searchQuery.toString()}`,
  );
  const ids = (found.results ?? []).map((r) => r.listing_id);
  if (!ids.length) return { shopId, count: found.count ?? 0, limit, offset, listings: [] };

  const idsQuery = new URLSearchParams({ includes: "Images" });
  for (const id of ids) idsQuery.append("listing_ids", String(id));
  const withImages = await etsyGetJson<EtsyListingsResponse>(
    `/listings/batch?${idsQuery.toString()}`,
  );

  // the batch endpoint doesn't promise to preserve order — resort by relevance
  const byId = new Map((withImages.results ?? []).map((r) => [r.listing_id, r]));
  const ordered = ids
    .map((id) => byId.get(id))
    .filter((r): r is EtsyRawListing => r !== undefined);

  return { shopId, count: found.count ?? 0, limit, offset, listings: ordered.map(mapListing) };
}
