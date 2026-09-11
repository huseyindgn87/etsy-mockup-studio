import { NextResponse } from "next/server";
import { getEtsySession } from "@/lib/etsy/auth";
import { EtsyApiError } from "@/lib/etsy/listings";
import { getSellerTaxonomyTree } from "@/lib/etsy/taxonomy";

export const dynamic = "force-dynamic";

/**
 * The full Etsy seller category tree (root nodes, nested `children`), for the
 * listing form's category picker. `GET /api/etsy/taxonomy`
 */
export async function GET() {
  if (!(await getEtsySession())) {
    return NextResponse.json({ error: "Not connected to Etsy." }, { status: 401 });
  }
  try {
    const tree = await getSellerTaxonomyTree();
    return NextResponse.json({ tree });
  } catch (err) {
    if (err instanceof EtsyApiError) {
      const status = err.status >= 400 && err.status <= 599 ? err.status : 502;
      return NextResponse.json({ error: err.message, etsy: err.body ?? null }, { status });
    }
    const message = err instanceof Error ? err.message : "Request failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
