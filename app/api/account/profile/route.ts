import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { PROFILE_ERROR_MESSAGES, updateProfile } from "@/lib/account/profile";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** `PATCH /api/account/profile` — first/last name and theme (any subset). */
export async function PATCH(request: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Expected a JSON body." }, { status: 400 });
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return NextResponse.json({ error: "Expected a JSON object." }, { status: 400 });
  }

  const result = await updateProfile(session.user.id, body as Record<string, unknown>);
  if (!result.ok) {
    return NextResponse.json({ error: PROFILE_ERROR_MESSAGES[result.error] }, { status: 400 });
  }
  return NextResponse.json({ profile: result.profile });
}
