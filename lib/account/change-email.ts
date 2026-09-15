import { prisma } from "@/lib/db/prisma";
import { verifyPassword } from "@/lib/auth/password";
import { isValidEmail, normalizeEmail } from "@/lib/auth/validate";

export type ChangeEmailError =
  | "invalid_email"
  | "password_required"
  | "wrong_password"
  | "same_email"
  | "email_taken";

export const CHANGE_EMAIL_ERROR_MESSAGES: Record<ChangeEmailError, string> = {
  invalid_email: "Enter a valid email address.",
  password_required: "Enter your current password to change your email.",
  wrong_password: "Current password is incorrect.",
  same_email: "That's already your email address.",
  email_taken: "An account with that email already exists.",
};

export const CHANGE_EMAIL_ERROR_STATUS: Record<ChangeEmailError, number> = {
  invalid_email: 400,
  password_required: 400,
  wrong_password: 403,
  same_email: 400,
  email_taken: 409,
};

function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === "P2002";
}

/**
 * Change the sign-in email. Always requires the account's current password —
 * checked before anything else about the target address is revealed (so the
 * "already taken" answer is never available without it). There is no email
 * verification step: the app has no email-sending flow.
 */
export async function changeEmail(
  userId: string,
  input: { newEmail?: unknown; currentPassword?: unknown },
): Promise<{ ok: true; email: string } | { ok: false; error: ChangeEmailError }> {
  const email = typeof input.newEmail === "string" ? normalizeEmail(input.newEmail) : "";
  const currentPassword = typeof input.currentPassword === "string" ? input.currentPassword : "";

  if (!isValidEmail(email)) return { ok: false, error: "invalid_email" };
  if (!currentPassword) return { ok: false, error: "password_required" };

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { email: true, passwordHash: true },
  });
  if (!user || !(await verifyPassword(currentPassword, user.passwordHash))) {
    return { ok: false, error: "wrong_password" };
  }

  if (user.email === email) return { ok: false, error: "same_email" };

  const taken = await prisma.user.findUnique({ where: { email }, select: { id: true } });
  if (taken) return { ok: false, error: "email_taken" };

  try {
    await prisma.user.update({ where: { id: userId }, data: { email } });
  } catch (err) {
    // Lost a race with another account claiming the same address.
    if (isUniqueViolation(err)) return { ok: false, error: "email_taken" };
    throw err;
  }
  return { ok: true, email };
}
