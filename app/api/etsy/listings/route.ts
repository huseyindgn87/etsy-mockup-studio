import { type NextRequest, NextResponse } from "next/server";
import {
  ETSY_LISTING_STATES,
  EtsyApiError,
  fetchShopListings,
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
 * List the connected user's shop listings.
 * `GET /api/etsy/listings?state=active&limit=24&offset=0`
 */
export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;

  try {
    const page = await fetchShopListings({
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
