import { NextResponse } from "next/server";
import { getEtsySession } from "@/lib/etsy/auth";
import { EtsyApiError, getShopSummary } from "@/lib/etsy/listings";

export const dynamic = "force-dynamic";

/** The connected user's shop name and currency, for the listing editor. */
export async function GET() {
  if (!(await getEtsySession())) {
    return NextResponse.json({ error: "Not connected to Etsy." }, { status: 401 });
  }
  try {
    const { shopName, currencyCode } = await getShopSummary();
    return NextResponse.json({ shopName, currencyCode });
  } catch (err) {
    if (err instanceof EtsyApiError) {
      const status = err.status >= 400 && err.status <= 599 ? err.status : 502;
      return NextResponse.json({ error: err.message, etsy: err.body ?? null }, { status });
    }
    const message = err instanceof Error ? err.message : "Request failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
