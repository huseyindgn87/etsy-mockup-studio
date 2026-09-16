import { NextResponse } from "next/server";
import { getEtsySession } from "@/lib/etsy/auth";
import { EtsyApiError } from "@/lib/etsy/listings";
import { getShopShippingProfiles } from "@/lib/etsy/shipping-profiles";

export const dynamic = "force-dynamic";

/** The connected shop's shipping profiles, for the bulk editor's Shipping section. */
export async function GET() {
  if (!(await getEtsySession())) {
    return NextResponse.json({ error: "Not connected to Etsy." }, { status: 401 });
  }
  try {
    const profiles = await getShopShippingProfiles();
    return NextResponse.json({ profiles });
  } catch (err) {
    if (err instanceof EtsyApiError) {
      const status = err.status >= 400 && err.status <= 599 ? err.status : 502;
      return NextResponse.json({ error: err.message, etsy: err.body ?? null }, { status });
    }
    const message = err instanceof Error ? err.message : "Request failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
