import { NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { hashPassword } from "@/lib/auth/password";
import { clientIp, takeRegistrationSlot } from "@/lib/auth/throttle";
import { REGISTRATION_ERROR_MESSAGES, validateRegistration } from "@/lib/auth/validate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * `POST /api/auth/register` — create an app account. Never touches Etsy —
 * this is the app's own credentials, not an Etsy password (we never ask for
 * one). The client signs in separately afterward via `next-auth/react`'s
 * `signIn("credentials", ...)`.
 *
 * Answers the same 201 whether or not the email already has an account, so
 * sign-up never reveals one exists (the existing account is left untouched).
 * Limited to 5 sign-ups per IP per hour (lib/auth/throttle.ts).
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

  const gate = await takeRegistrationSlot(clientIp(request.headers));
  if (!gate.ok) {
    const minutes = Math.max(1, Math.ceil((gate.until.getTime() - Date.now()) / 60_000));
    return NextResponse.json(
      {
        error: `Too many sign-ups from this network. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`,
        retryAt: gate.until.toISOString(),
      },
      { status: 429, headers: { "Retry-After": String(minutes * 60) } },
    );
  }

  const passwordHash = await hashPassword(result.password);
  const existing = await prisma.user.findUnique({ where: { email: result.email } });
  if (!existing) {
    await prisma.user.create({
      data: { email: result.email, passwordHash, termsAcceptedAt: new Date() },
      select: { id: true },
    });
  }

  return NextResponse.json({ ok: true }, { status: 201 });
}
