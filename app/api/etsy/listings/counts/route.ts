import { NextResponse } from "next/server";
import { getEtsySession } from "@/lib/etsy/auth";
import { EtsyApiError, getShopListingStateCounts } from "@/lib/etsy/listings";

export const dynamic = "force-dynamic";

/**
 * The connected shop's listing count for every state — `active`, `draft`,
 * `inactive`, `sold_out`, `expired` — for the listings page's sidebar
 * filters. `GET /api/etsy/listings/counts`.
 */
export async function GET() {
  if (!(await getEtsySession())) {
    return NextResponse.json({ error: "Not connected to Etsy." }, { status: 401 });
  }
  try {
    const counts = await getShopListingStateCounts();
    return NextResponse.json({ counts });
  } catch (err) {
    if (err instanceof EtsyApiError) {
      const status = err.status >= 400 && err.status <= 599 ? err.status : 502;
      return NextResponse.json({ error: err.message, etsy: err.body ?? null }, { status });
    }
    const message = err instanceof Error ? err.message : "Request failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
