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
export async function fetchAllShopListings(
  options: FetchAllShopListingsOptions = {},
): Promise<ShopListingsPage> {
  const state = options.state ?? "active";
  const shopId = await getShopId();

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

  return { shopId, count: first.count, limit: listings.length, offset: 0, listings };
}
