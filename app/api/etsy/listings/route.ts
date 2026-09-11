import { type NextRequest, NextResponse } from "next/server";
import {
  ETSY_LISTING_STATES,
  EtsyApiError,
  fetchShopListings,
  searchShopListings,
  type EtsyListingState,
} from "@/lib/etsy/listings";

export const dynamic = "force-dynamic";

function parseState(value: string | null): EtsyListingState {
  return ETSY_LISTING_STATES.includes(value as EtsyListingState)
    ? (value as EtsyListingState)
    : "active";
}

function parseInt10(value: string | null, fallback: number): number {
  const n = Number.parseInt(value ?? "", 10);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * List (or keyword-search) the connected user's shop listings.
 * `GET /api/etsy/listings?state=active&limit=24&offset=0`
 * `GET /api/etsy/listings?keywords=tumbler&limit=24&offset=0` — searches only
 * ACTIVE listings (Etsy's shop-scoped search has no state filter), ignoring
 * `state`. Good for a shop with thousands of listings, where paging through
 * everything to find one by title isn't practical.
 */
export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const keywords = params.get("keywords")?.trim();

  try {
    const page = keywords
      ? await searchShopListings({
          keywords,
          limit: parseInt10(params.get("limit"), 24),
          offset: parseInt10(params.get("offset"), 0),
        })
      : await fetchShopListings({
          state: parseState(params.get("state")),
          limit: parseInt10(params.get("limit"), 24),
          offset: parseInt10(params.get("offset"), 0),
        });
    return NextResponse.json(page);
  } catch (err) {
    if (err instanceof EtsyApiError) {
      const status = err.status >= 400 && err.status <= 599 ? err.status : 502;
      return NextResponse.json(
        { error: err.message, etsy: err.body ?? null },
        { status },
      );
    }
    const message = err instanceof Error ? err.message : "Request failed";
    const status = message === "Not connected to Etsy." ? 401 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
