import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { getStoredListingStateCounts, NotConnectedError, resolveActiveShopId } from "@/lib/etsy/listing-store";
import { EtsyApiError } from "@/lib/etsy/listings";

export const dynamic = "force-dynamic";

/**
 * The connected shop's stored listing count for every state — `active`,
 * `draft`, `inactive`, `sold_out`, `expired` — for the listings page's
 * sidebar filters. `GET /api/etsy/listings/counts`.
 */
export async function GET() {
  const appSession = await auth();
  if (!appSession?.user?.id) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }
  try {
    const shopId = await resolveActiveShopId(appSession.user.id);
    const counts = await getStoredListingStateCounts(appSession.user.id, shopId);
    return NextResponse.json({ counts });
  } catch (err) {
    if (err instanceof NotConnectedError) {
      return NextResponse.json({ error: err.message }, { status: 401 });
    }
    if (err instanceof EtsyApiError) {
      return NextResponse.json({ error: err.message, etsy: err.body ?? null }, { status: 502 });
    }
    const message = err instanceof Error ? err.message : "Request failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
