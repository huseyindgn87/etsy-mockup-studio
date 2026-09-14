import { type NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import {
  listAllStoredListings,
  listStoredListings,
  NotConnectedError,
  resolveActiveShopId,
} from "@/lib/etsy/listing-store";
import { EtsyApiError, ETSY_LISTING_STATES, type EtsyListingState } from "@/lib/etsy/listings";

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
 * List the connected user's shop listings, read from the DB-backed cache
 * (lib/etsy/listing-store.ts) — kept fresh by the listings page's on-demand
 * refresh, not by a live Etsy call on every request.
 * `GET /api/etsy/listings?state=active&limit=24&offset=0` — one page.
 * `GET /api/etsy/listings?state=active&all=true` — every stored listing for
 * that state. Used for exact client-side title filtering — see the listings
 * page's `load()` for why Etsy's own shop search isn't used for that.
 */
export async function GET(request: NextRequest) {
  const appSession = await auth();
  if (!appSession?.user?.id) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }

  const params = request.nextUrl.searchParams;
  const all = params.get("all") === "true" || params.get("all") === "1";

  try {
    const shopId = await resolveActiveShopId(appSession.user.id);
    const state = parseState(params.get("state"));
    const page = all
      ? await listAllStoredListings(appSession.user.id, shopId, state)
      : await listStoredListings({
          userId: appSession.user.id,
          shopId,
          state,
          limit: parseInt10(params.get("limit"), 24),
          offset: parseInt10(params.get("offset"), 0),
        });
    return NextResponse.json(page);
  } catch (err) {
    if (err instanceof NotConnectedError) {
      return NextResponse.json({ error: err.message }, { status: 401 });
    }
    if (err instanceof EtsyApiError) {
      const status = err.status >= 400 && err.status <= 599 ? err.status : 502;
      return NextResponse.json({ error: err.message, etsy: err.body ?? null }, { status });
    }
    const message = err instanceof Error ? err.message : "Request failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
