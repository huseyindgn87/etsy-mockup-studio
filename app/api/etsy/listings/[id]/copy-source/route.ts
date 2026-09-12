import { NextResponse } from "next/server";
import { getEtsySession } from "@/lib/etsy/auth";
import { EtsyApiError } from "@/lib/etsy/listings";
import { getListingCopySource } from "@/lib/etsy/listing-copy";

export const dynamic = "force-dynamic";

/**
 * Read-only prefill data for the "Copy to a copy" editor flow — title,
 * description, tags, price, section, and photos (as data URLs) for one
 * listing. `GET`-only; never modifies the source listing (see memory
 * `live-listing-never-auto-modified`).
 * `GET /api/etsy/listings/[id]/copy-source`
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!(await getEtsySession())) {
    return NextResponse.json({ error: "Not connected to Etsy." }, { status: 401 });
  }
  const { id: raw } = await params;
  const listingId = Number.parseInt(raw, 10);
  if (!Number.isInteger(listingId) || listingId <= 0) {
    return NextResponse.json({ error: "Invalid listing id." }, { status: 400 });
  }

  try {
    const source = await getListingCopySource(listingId);
    return NextResponse.json(source);
  } catch (err) {
    if (err instanceof EtsyApiError) {
      const status = err.status >= 400 && err.status <= 599 ? err.status : 502;
      return NextResponse.json({ error: err.message, etsy: err.body ?? null }, { status });
    }
    const message = err instanceof Error ? err.message : "Request failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
