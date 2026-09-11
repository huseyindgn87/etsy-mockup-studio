import { NextResponse, type NextRequest } from "next/server";
import { getEtsySession } from "@/lib/etsy/auth";
import { getSavedCalibration, saveCalibration } from "@/lib/mockup/calibration-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const HASH_RE = /^[a-f0-9]{16,128}$/i;

/**
 * `GET /api/mockups/calibrations?contentHash=<hex>` — the signed-in user's
 * saved calibration for that PSD content hash, or `{ calibration: null }`
 * when none is saved yet.
 */
export async function GET(request: NextRequest) {
  const session = await getEtsySession();
  if (!session) {
    return NextResponse.json({ error: "Not connected to Etsy." }, { status: 401 });
  }

  const contentHash = request.nextUrl.searchParams.get("contentHash");
  if (!contentHash || !HASH_RE.test(contentHash)) {
    return NextResponse.json(
      { error: "`contentHash` query param (hex) is required." },
      { status: 400 },
    );
  }

  const calibration = await getSavedCalibration(session.userId, contentHash);
  return NextResponse.json({ calibration });
}

/**
 * `PUT /api/mockups/calibrations` — save (upsert) the calibration for a PSD
 * content hash, scoped to the signed-in user. Body: `{ contentHash, calibration }`.
 * `calibration` is coerced through the same validator the render routes use,
 * so a malformed client payload never reaches the database as-is.
 */
export async function PUT(request: Request) {
  const session = await getEtsySession();
  if (!session) {
    return NextResponse.json({ error: "Not connected to Etsy." }, { status: 401 });
  }

  let body: { contentHash?: unknown; calibration?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Expected a JSON body." }, { status: 400 });
  }

  const contentHash = typeof body.contentHash === "string" ? body.contentHash : "";
  if (!HASH_RE.test(contentHash)) {
    return NextResponse.json({ error: "`contentHash` must be a hex string." }, { status: 400 });
  }

  const calibration = await saveCalibration(session.userId, contentHash, body.calibration);
  return NextResponse.json({ calibration });
}
