import { type NextRequest, NextResponse } from "next/server";
import { MAX_BULK_UPDATES } from "@/lib/etsy/bulk-edit";
import { fetchListingAttributes } from "@/lib/etsy/listing-attributes";
import { parseListingIds, resolveListingScope } from "@/lib/etsy/listing-scope";
import { listStoredListingsByIds } from "@/lib/etsy/listing-store";
import { EtsyApiError } from "@/lib/etsy/listings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * `GET /api/etsy/listings/bulk/attributes?ids=1,2,3` — the category
 * attributes (Optional group) currently set on the selected listings.
 *
 * Separate from `/api/etsy/listings/bulk` because Etsy has no batch form of
 * this read: it costs one call per listing, so the editor only asks for it
 * when the Optional group is opened.
 *
 * Read-only. Ids are checked against the caller's own cached listings first,
 * so this can only ever read listings belonging to the signed-in user's
 * active shop; anything else comes back in `missing`.
 */
export async function GET(request: NextRequest) {
  const resolved = await resolveListingScope();
  if (!resolved.ok) return resolved.response;
  const { userId, shopId } = resolved.scope;

  const ids = parseListingIds(request.nextUrl.searchParams.get("ids"));
  if (ids.length === 0) {
    return NextResponse.json({ error: "Select at least one listing." }, { status: 400 });
  }
  if (ids.length > MAX_BULK_UPDATES) {
    return NextResponse.json(
      { error: `You can edit at most ${MAX_BULK_UPDATES} listings at once.` },
      { status: 400 },
    );
  }

  const owned = await listStoredListingsByIds(userId, shopId, ids);
  const ownedIds = owned.map((l) => l.listingId);
  const missing = ids.filter((id) => !ownedIds.includes(id));

  try {
    const byListing = await fetchListingAttributes(Number(shopId), ownedIds);
    return NextResponse.json({
      attributes: Object.fromEntries(byListing),
      missing,
    });
  } catch (err) {
    if (err instanceof EtsyApiError) {
      const status = err.status >= 400 && err.status <= 599 ? err.status : 502;
      return NextResponse.json({ error: err.message, etsy: err.body ?? null }, { status });
    }
    const message = err instanceof Error ? err.message : "Request failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
