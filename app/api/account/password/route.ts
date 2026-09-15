import { NextResponse } from "next/server";
import { auth } from "@/auth";
import {
  CHANGE_PASSWORD_ERROR_MESSAGES,
  CHANGE_PASSWORD_ERROR_STATUS,
  changePassword,
} from "@/lib/account/change-password";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** `POST /api/account/password` — `{ currentPassword, newPassword, confirmPassword }`. */
export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) ?? {};
  } catch {
    return NextResponse.json({ error: "Expected a JSON body." }, { status: 400 });
  }

  const result = await changePassword(session.user.id, {
    currentPassword: body.currentPassword,
    newPassword: body.newPassword,
    confirmPassword: body.confirmPassword,
  });
  if (!result.ok) {
    return NextResponse.json(
      { error: CHANGE_PASSWORD_ERROR_MESSAGES[result.error] },
      { status: CHANGE_PASSWORD_ERROR_STATUS[result.error] },
    );
  }
  return NextResponse.json({ ok: true });
}
