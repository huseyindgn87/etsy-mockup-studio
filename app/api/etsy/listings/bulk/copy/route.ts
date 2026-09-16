import { NextResponse } from "next/server";
import { MAX_BULK_UPDATES } from "@/lib/etsy/bulk-edit";
import { createCopyDrafts } from "@/lib/drafts/bulk-copy";
import { parseListingIds, resolveListingScope } from "@/lib/etsy/listing-scope";
import { listStoredListingsByIds } from "@/lib/etsy/listing-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * `POST /api/etsy/listings/bulk/copy` — `{ listingIds: [...] }`. Creates one
 * saved draft per selected listing, seeded as a copy of it.
 *
 * Deliberately makes no Etsy call at all: a copy is a row in our own DB until
 * the user opens it in the editor and publishes it, so the live listings are
 * untouched (see memory `live-listing-never-auto-modified`).
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
      { error: `You can copy at most ${MAX_BULK_UPDATES} listings at once.` },
      { status: 400 },
    );
  }

  const owned = await listStoredListingsByIds(userId, shopId, ids);
  if (owned.length === 0) {
    return NextResponse.json({ error: "None of those listings were found." }, { status: 404 });
  }

  const drafts = await createCopyDrafts(
    userId,
    owned.map((l) => ({ listingId: l.listingId, title: l.title })),
  );
  return NextResponse.json({ drafts, copied: drafts.length }, { status: 201 });
}
