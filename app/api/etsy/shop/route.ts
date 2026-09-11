import { NextResponse } from "next/server";
import { getEtsySession } from "@/lib/etsy/auth";
import { EtsyApiError, getShopName } from "@/lib/etsy/listings";

export const dynamic = "force-dynamic";

/** The connected user's shop name, for the listing editor header. */
export async function GET() {
  if (!(await getEtsySession())) {
    return NextResponse.json({ error: "Not connected to Etsy." }, { status: 401 });
  }
  try {
    const shopName = await getShopName();
    return NextResponse.json({ shopName });
  } catch (err) {
    if (err instanceof EtsyApiError) {
      const status = err.status >= 400 && err.status <= 599 ? err.status : 502;
      return NextResponse.json({ error: err.message, etsy: err.body ?? null }, { status });
    }
    const message = err instanceof Error ? err.message : "Request failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
