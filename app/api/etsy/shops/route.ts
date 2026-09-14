import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { getEtsySession } from "@/lib/etsy/auth";
import { listShopConnections } from "@/lib/etsy/shop-connections";

export const dynamic = "force-dynamic";

/**
 * Every Etsy shop the signed-in user has connected, most recently connected
 * first, flagged with which one is active in the current session — backs
 * the listings page's refresh modal "Switch shop" dropdown.
 */
export async function GET() {
  const appSession = await auth();
  if (!appSession?.user?.id) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }

  const etsySession = await getEtsySession();
  const shops = await listShopConnections(appSession.user.id, etsySession?.userId ?? null);
  return NextResponse.json({ shops });
}
