import { NextResponse } from "next/server";
import { loadListingForEditor } from "@/lib/etsy/listing-editor-load";
import { resolveListingScope } from "@/lib/etsy/listing-scope";
import { EtsyApiError } from "@/lib/etsy/listings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * `GET /api/etsy/listings/[id]/editor` — an existing listing as the editor
 * form's value, from the listings cache (lib/etsy/listing-editor-load.ts).
 * Read-only.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const resolved = await resolveListingScope();
  if (!resolved.ok) return resolved.response;
  const { userId, shopId } = resolved.scope;

  const { id: raw } = await params;
  const listingId = Number.parseInt(raw, 10);
  if (!Number.isInteger(listingId) || listingId <= 0) {
    return NextResponse.json({ error: "Invalid listing id." }, { status: 400 });
  }

  try {
    const loaded = await loadListingForEditor(userId, shopId, listingId);
    if (!loaded) return NextResponse.json({ error: "Listing not found." }, { status: 404 });
    return NextResponse.json(loaded);
  } catch (err) {
    if (err instanceof EtsyApiError) {
      const status = err.status >= 400 && err.status <= 599 ? err.status : 502;
      return NextResponse.json({ error: err.message, etsy: err.body ?? null }, { status });
    }
    const message = err instanceof Error ? err.message : "Request failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
