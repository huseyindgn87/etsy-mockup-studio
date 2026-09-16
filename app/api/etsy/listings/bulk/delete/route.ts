import { NextResponse } from "next/server";
import { deleteEtsyListings } from "@/lib/etsy/bulk-apply";
import { MAX_BULK_UPDATES } from "@/lib/etsy/bulk-edit";
import { parseListingIds, resolveListingScope } from "@/lib/etsy/listing-scope";
import { listStoredListingsByIds, markStoredListingsRemoved } from "@/lib/etsy/listing-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * `POST /api/etsy/listings/bulk/delete` — `{ listingIds: [...] }`. Deletes
 * each listing on Etsy permanently, then marks the cached rows removed.
 *
 * Only ever reached from the listings table's explicit delete confirmation.
 * Ids are checked against the caller's own cached listings first, so another
 * user's listing is reported as not found and never sent to Etsy.
 *
 * Etsy requires the `listings_d` OAuth scope for this, which is **not** in
 * this app's default scope string — until the shop is reconnected with it,
 * Etsy answers 403 and that message is reported against each row.
 */
export async function POST(request: Request) {
  const resolved = await resolveListingScope();
  if (!resolved.ok) return resolved.response;
  const { userId, shopId } = resolved.scope;

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Expected a JSON body." }, { status: 400 });
  }

  const ids = parseListingIds(body.listingIds);
  if (ids.length === 0) {
    return NextResponse.json({ error: "Select at least one listing." }, { status: 400 });
  }
  if (ids.length > MAX_BULK_UPDATES) {
    return NextResponse.json(
      { error: `You can delete at most ${MAX_BULK_UPDATES} listings at once.` },
      { status: 400 },
    );
  }

  const owned = await listStoredListingsByIds(userId, shopId, ids);
  const ownedIds = owned.map((l) => l.listingId);
  const notFound = ids
    .filter((id) => !ownedIds.includes(id))
    .map((listingId) => ({ listingId, ok: false as const, error: "Listing not found." }));

  const deleted = await deleteEtsyListings(ownedIds);
  await markStoredListingsRemoved(
    userId,
    shopId,
    deleted.filter((r) => r.ok).map((r) => r.listingId),
  );

  const results = [...deleted, ...notFound];
  return NextResponse.json({
    results,
    deleted: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
  });
}
