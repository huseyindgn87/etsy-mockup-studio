import { NextResponse } from "next/server";
import { auth } from "@/auth";
import {
  beginTwoFactorSetup,
  TWO_FACTOR_ERROR_MESSAGES,
  TWO_FACTOR_ERROR_STATUS,
} from "@/lib/account/two-factor";
import { TwoFactorKeyError } from "@/lib/auth/two-factor-key";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** `POST /api/account/two-factor/setup` — a pending secret + its QR code. 2FA stays off until /enable. */
export async function POST() {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

  try {
    const result = await beginTwoFactorSetup(session.user.id);
    if (!result.ok) {
      return NextResponse.json(
        { error: TWO_FACTOR_ERROR_MESSAGES[result.error] },
        { status: TWO_FACTOR_ERROR_STATUS[result.error] },
      );
    }
    return NextResponse.json(
      { secret: result.secret, otpauthUrl: result.otpauthUrl, qrDataUrl: result.qrDataUrl },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    if (!(err instanceof TwoFactorKeyError)) throw err;
    console.error(`[two-factor] ${err.message}`);
    return NextResponse.json(
      { error: "Two-factor authentication isn't configured on this server yet." },
      { status: 503 },
    );
  }
}
