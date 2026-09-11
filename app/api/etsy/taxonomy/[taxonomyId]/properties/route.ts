import { NextResponse } from "next/server";
import { getEtsySession } from "@/lib/etsy/auth";
import { EtsyApiError } from "@/lib/etsy/listings";
import { getTaxonomyProperties } from "@/lib/etsy/taxonomy";

export const dynamic = "force-dynamic";

/**
 * Category-specific listing properties (primary colour, occasion, sleeve
 * length, ...) for one taxonomy node.
 * `GET /api/etsy/taxonomy/[taxonomyId]/properties`
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ taxonomyId: string }> },
) {
  if (!(await getEtsySession())) {
    return NextResponse.json({ error: "Not connected to Etsy." }, { status: 401 });
  }
  const { taxonomyId: raw } = await params;
  const taxonomyId = Number.parseInt(raw, 10);
  if (!Number.isInteger(taxonomyId) || taxonomyId <= 0) {
    return NextResponse.json({ error: "Invalid taxonomy id." }, { status: 400 });
  }

  try {
    const properties = await getTaxonomyProperties(taxonomyId);
    return NextResponse.json({ properties });
  } catch (err) {
    if (err instanceof EtsyApiError) {
      const status = err.status >= 400 && err.status <= 599 ? err.status : 502;
      return NextResponse.json({ error: err.message, etsy: err.body ?? null }, { status });
    }
    const message = err instanceof Error ? err.message : "Request failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
