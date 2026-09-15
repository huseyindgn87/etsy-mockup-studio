import { NextResponse } from "next/server";
import { auth } from "@/auth";
import {
  CHANGE_EMAIL_ERROR_MESSAGES,
  CHANGE_EMAIL_ERROR_STATUS,
  changeEmail,
} from "@/lib/account/change-email";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** `POST /api/account/email` — `{ newEmail, currentPassword }`. The password is always required. */
export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) ?? {};
  } catch {
    return NextResponse.json({ error: "Expected a JSON body." }, { status: 400 });
  }

  const result = await changeEmail(session.user.id, {
    newEmail: body.newEmail,
    currentPassword: body.currentPassword,
  });
  if (!result.ok) {
    return NextResponse.json(
      { error: CHANGE_EMAIL_ERROR_MESSAGES[result.error] },
      { status: CHANGE_EMAIL_ERROR_STATUS[result.error] },
    );
  }
  return NextResponse.json({ email: result.email });
}
