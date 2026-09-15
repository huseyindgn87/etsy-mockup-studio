import { NextResponse } from "next/server";
import { auth } from "@/auth";
import {
  disableTwoFactor,
  TWO_FACTOR_ERROR_MESSAGES,
  TWO_FACTOR_ERROR_STATUS,
} from "@/lib/account/two-factor";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** `POST /api/account/two-factor/disable` — `{ password }`. The account password is always required. */
export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) ?? {};
  } catch {
    return NextResponse.json({ error: "Expected a JSON body." }, { status: 400 });
  }

  const result = await disableTwoFactor(session.user.id, body.password);
  if (!result.ok) {
    return NextResponse.json(
      { error: TWO_FACTOR_ERROR_MESSAGES[result.error] },
      { status: TWO_FACTOR_ERROR_STATUS[result.error] },
    );
  }
  return NextResponse.json({ ok: true });
}
