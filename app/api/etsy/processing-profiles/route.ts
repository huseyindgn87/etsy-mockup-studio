import { NextResponse } from "next/server";
import { getEtsySession } from "@/lib/etsy/auth";
import { EtsyApiError } from "@/lib/etsy/listings";
import { getShopProcessingProfiles } from "@/lib/etsy/processing-profiles";

export const dynamic = "force-dynamic";

/** The connected shop's processing profiles ("readiness states"), for the listing form's Shipping tab. */
export async function GET() {
  if (!(await getEtsySession())) {
    return NextResponse.json({ error: "Not connected to Etsy." }, { status: 401 });
  }
  try {
    const profiles = await getShopProcessingProfiles();
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
