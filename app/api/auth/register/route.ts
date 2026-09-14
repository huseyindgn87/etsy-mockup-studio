import { NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { hashPassword } from "@/lib/auth/password";
import { REGISTRATION_ERROR_MESSAGES, validateRegistration } from "@/lib/auth/validate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * `POST /api/auth/register` — create an app account. Never touches Etsy —
 * this is the app's own credentials, not an Etsy password (we never ask for
 * one). The client signs in separately afterward via `next-auth/react`'s
 * `signIn("credentials", ...)`.
 */
export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Expected a JSON body." }, { status: 400 });
  }

  const result = validateRegistration(body as Record<string, unknown>);
  if (!result.ok) {
    return NextResponse.json(
      { error: REGISTRATION_ERROR_MESSAGES[result.error] },
      { status: 400 },
    );
  }

  const existing = await prisma.user.findUnique({ where: { email: result.email } });
  if (existing) {
    return NextResponse.json(
      { error: REGISTRATION_ERROR_MESSAGES.email_taken },
      { status: 409 },
    );
  }

  const passwordHash = await hashPassword(result.password);
  const user = await prisma.user.create({
    data: { email: result.email, passwordHash },
    select: { id: true, email: true },
  });

  return NextResponse.json({ user }, { status: 201 });
}
