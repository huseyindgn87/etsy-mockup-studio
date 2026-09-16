import { type NextRequest, NextResponse } from "next/server";
import { MAX_BULK_UPDATES } from "@/lib/etsy/bulk-edit";
import { fetchListingInventories } from "@/lib/etsy/listing-inventory";
import { parseListingIds, resolveListingScope } from "@/lib/etsy/listing-scope";
import { listStoredListingsByIds } from "@/lib/etsy/listing-store";
import { EtsyApiError } from "@/lib/etsy/listings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * `GET /api/etsy/listings/bulk/inventory?ids=1,2,3` — each selected listing's
 * variation grid, for the Inventory group's per-listing Variations cards.
 *
 * Separate from `/api/etsy/listings/bulk` because Etsy's batch endpoint can't
 * include inventory: it costs one call per listing, so the editor only asks
 * for it when Variations is opened.
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
    const byListing = await fetchListingInventories(ownedIds);
    return NextResponse.json({
      inventories: Object.fromEntries(byListing),
      // A listing Etsy wouldn't hand over its inventory for is reported the
      // same way as one that isn't the caller's — the card says so rather
      // than showing an empty grid.
      missing: [...missing, ...ownedIds.filter((id) => !byListing.has(id))],
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
