import { prisma } from "@/lib/db/prisma";
import { verifyPassword } from "./password";
import { normalizeEmail } from "./validate";

export interface AuthorizedUser {
  id: string;
  email: string;
  name: string | null;
  /** Whether "Keep me signed in" was checked on /login — see auth.ts's jwt callback and lib/auth/session-cookie.ts. */
  rememberMe: boolean;
}

/** Truthy exactly the way a "remember me" checkbox arrives over the wire: a real `true`, or the string next-auth/react's `signIn()` serializes a boolean into via `URLSearchParams`. */
function isChecked(value: unknown): boolean {
  return value === true || value === "true";
}

/**
 * The Credentials provider's `authorize` logic, pulled out of auth.ts so it's
 * unit-testable without going through NextAuth's own request plumbing.
 * Returns `null` on any failure (unknown email, wrong password) — same
 * response either way, so a failed sign-in never reveals which one it was.
 */
export async function authorizeCredentials(
  rawEmail: unknown,
  rawPassword: unknown,
  rawRememberMe?: unknown,
): Promise<AuthorizedUser | null> {
  const email = typeof rawEmail === "string" ? normalizeEmail(rawEmail) : "";
  const password = typeof rawPassword === "string" ? rawPassword : "";
  if (!email || !password) return null;

  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) return null;

  const valid = await verifyPassword(password, user.passwordHash);
  if (!valid) return null;

  return { id: user.id, email: user.email, name: user.name, rememberMe: isChecked(rawRememberMe) };
}
