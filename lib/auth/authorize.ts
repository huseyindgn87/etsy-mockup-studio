import { prisma } from "@/lib/db/prisma";
import { verifyPassword } from "./password";
import { verifySecondFactor } from "./second-factor";
import { InvalidTwoFactorCodeError, TwoFactorRequiredError } from "./two-factor-errors";
import { normalizeEmail } from "./validate";

export interface AuthorizedUser {
  id: string;
  email: string;
  name: string | null;
  /** Whether "Keep me signed in" was checked on /login — see auth.ts's jwt callback and lib/auth/session-cookie.ts. */
  rememberMe: boolean;
}

/** The optional second step, as submitted from /login's code screen. */
export interface SecondFactorInput {
  /** A 6-digit authenticator code. */
  code?: unknown;
  /** One of the account's single-use recovery codes. */
  recoveryCode?: unknown;
}

/** Truthy exactly the way a "remember me" checkbox arrives over the wire: a real `true`, or the string next-auth/react's `signIn()` serializes a boolean into via `URLSearchParams`. */
function isChecked(value: unknown): boolean {
  return value === true || value === "true";
}

function trimmed(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * The Credentials provider's `authorize` logic, pulled out of auth.ts so it's
 * unit-testable without going through NextAuth's own request plumbing.
 * Returns `null` on any first-factor failure (unknown email, wrong password)
 * — same response either way, so a failed sign-in never reveals which one it
 * was, nor whether the account has two-factor auth on.
 *
 * Only once the password is right, for an account with 2FA on, it throws
 * instead: `TwoFactorRequiredError` when no code was sent (the login page
 * then asks for one), `InvalidTwoFactorCodeError` when the code or recovery
 * code is wrong, expired or already used. No session is issued either way.
 */
export async function authorizeCredentials(
  rawEmail: unknown,
  rawPassword: unknown,
  rawRememberMe?: unknown,
  secondFactor: SecondFactorInput = {},
): Promise<AuthorizedUser | null> {
  const email = typeof rawEmail === "string" ? normalizeEmail(rawEmail) : "";
  const password = typeof rawPassword === "string" ? rawPassword : "";
  if (!email || !password) return null;

  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) return null;

  const valid = await verifyPassword(password, user.passwordHash);
  if (!valid) return null;

  if (user.twoFactorEnabled) {
    const code = trimmed(secondFactor.code);
    const recoveryCode = trimmed(secondFactor.recoveryCode);
    if (!code && !recoveryCode) throw new TwoFactorRequiredError();
    if (!(await verifySecondFactor(user, { code, recoveryCode }))) throw new InvalidTwoFactorCodeError();
  }

  return { id: user.id, email: user.email, name: user.name, rememberMe: isChecked(rawRememberMe) };
}
