import { NextResponse } from "next/server";
import { auth } from "@/auth";
import {
  enableTwoFactor,
  TWO_FACTOR_ERROR_MESSAGES,
  TWO_FACTOR_ERROR_STATUS,
} from "@/lib/account/two-factor";
import { TwoFactorKeyError } from "@/lib/auth/two-factor-key";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** `POST /api/account/two-factor/enable` — `{ code }`. Returns the recovery codes, once. */
export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) ?? {};
  } catch {
    return NextResponse.json({ error: "Expected a JSON body." }, { status: 400 });
  }

  try {
    const result = await enableTwoFactor(session.user.id, body.code);
    if (!result.ok) {
      return NextResponse.json(
        { error: TWO_FACTOR_ERROR_MESSAGES[result.error] },
        { status: TWO_FACTOR_ERROR_STATUS[result.error] },
      );
    }
    return NextResponse.json(
      { recoveryCodes: result.recoveryCodes },
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
