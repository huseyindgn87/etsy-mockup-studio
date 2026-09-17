import { NextResponse } from "next/server";
import { applyBulkUpdates, type BulkResult } from "@/lib/etsy/bulk-apply";
import { parseBulkUpdates } from "@/lib/etsy/bulk-edit";
import { resolveListingScope } from "@/lib/etsy/listing-scope";
import { applyStoredListingPatch, listStoredListingsByIds } from "@/lib/etsy/listing-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * `POST /api/etsy/listings/bulk/save` — `{ updates: [{ listingId, patch }] }`.
 *
 * The one place bulk editing writes to Etsy. Each listing gets only the
 * fields targeted at it, as a PATCH, so untouched fields keep their values;
 * one listing failing doesn't stop the rest, and the response says per
 * listing what happened — `partial` when only its variation photos failed.
 *
 * Every id is checked against the caller's own cached listings first, so a
 * listing belonging to another user (or to another of this user's shops) is
 * reported as not found and never sent to Etsy.
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

  const parsed = parseBulkUpdates(body.updates);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });

  const owned = await listStoredListingsByIds(
    userId,
    shopId,
    parsed.value.map((u) => u.listingId),
  );
  const ownedIds = new Set(owned.map((l) => l.listingId));

  const toWrite = parsed.value.filter((u) => ownedIds.has(u.listingId));
  const notFound = parsed.value
    .filter((u) => !ownedIds.has(u.listingId))
    .map((u) => ({ listingId: u.listingId, ok: false as const, error: "Listing not found." }));

  const written = await applyBulkUpdates(Number(shopId), toWrite);

  // Mirror what actually landed into the cached rows the listings table reads.
  // A partial save landed everything but the variation photos.
  for (const result of written) {
    if (!result.ok && !result.partial) continue;
    const patch = toWrite.find((u) => u.listingId === result.listingId)!.patch;
    await applyStoredListingPatch(userId, shopId, result.listingId, patch);
  }

  const results: BulkResult[] = [...written, ...notFound];
  return NextResponse.json({
    results,
    saved: results.filter((r) => r.ok).length,
    partial: results.filter((r) => r.partial).length,
    failed: results.filter((r) => !r.ok && !r.partial).length,
  });
}
