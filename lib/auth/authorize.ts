import { prisma } from "@/lib/db/prisma";
import { hashPassword, verifyPassword } from "./password";
import { verifySecondFactor } from "./second-factor";
import {
  checkAccount,
  checkIpLogin,
  clearAccount,
  recordAccountFailure,
  recordIpLoginFailure,
  type AccountGate,
} from "./throttle";
import { verifyTurnstile } from "./turnstile";
import {
  AccountLockedError,
  EmailVerificationLockedError,
  HumanCheckFailedError,
  HumanCheckRequiredError,
  InvalidTwoFactorCodeError,
  IpRateLimitedError,
  TwoFactorRequiredError,
} from "./two-factor-errors";
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

/** Where the attempt came from, for the brute-force limits in lib/auth/throttle.ts. */
export interface SignInContext {
  ip?: string;
  /** The Turnstile response token, required once the account has been locked. */
  turnstileToken?: unknown;
  now?: Date;
}

let dummyHash: Promise<string> | undefined;

/** Compared against when the email has no account, so a miss takes as long as a wrong password. */
function passwordHashFor(user: { passwordHash: string } | null): Promise<string> {
  if (user) return Promise.resolve(user.passwordHash);
  dummyHash ??= hashPassword("no-account-has-this-password");
  return dummyHash;
}

function throwIfLocked(gate: AccountGate): void {
  if (gate.kind === "email_locked") throw new EmailVerificationLockedError();
  if (gate.kind === "locked") throw new AccountLockedError(gate.until);
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
 *
 * Wrong passwords and wrong codes both count toward the account's and the
 * IP's limits (lib/auth/throttle.ts); a locked account or IP, or a missing
 * or failed human check, throws its own `CredentialsSignin` code before the
 * password is even looked at. None of them depends on whether the email has
 * an account.
 */
export async function authorizeCredentials(
  rawEmail: unknown,
  rawPassword: unknown,
  rawRememberMe?: unknown,
  secondFactor: SecondFactorInput = {},
  context: SignInContext = {},
): Promise<AuthorizedUser | null> {
  const email = typeof rawEmail === "string" ? normalizeEmail(rawEmail) : "";
  const password = typeof rawPassword === "string" ? rawPassword : "";
  if (!email || !password) return null;

  const now = context.now ?? new Date();
  const ip = context.ip ?? "unknown";

  const ipGate = await checkIpLogin(ip, now);
  if (!ipGate.ok) throw new IpRateLimitedError(ipGate.until);

  const gate = await checkAccount(email, now);
  throwIfLocked(gate);
  if (gate.kind === "open" && gate.humanCheck) {
    const token = trimmed(context.turnstileToken);
    if (!token) throw new HumanCheckRequiredError();
    if (!(await verifyTurnstile(token, ip))) throw new HumanCheckFailedError();
  }

  /** Counts a failed attempt against the account and the IP; throws when it just locked the account. */
  async function fail(): Promise<void> {
    await recordIpLoginFailure(ip, now);
    throwIfLocked(await recordAccountFailure(email, now));
  }

  const user = await prisma.user.findUnique({ where: { email } });
  const valid = await verifyPassword(password, await passwordHashFor(user));
  if (!user || !valid) {
    await fail();
    return null;
  }

  if (user.twoFactorEnabled) {
    const code = trimmed(secondFactor.code);
    const recoveryCode = trimmed(secondFactor.recoveryCode);
    if (!code && !recoveryCode) throw new TwoFactorRequiredError();
    if (!(await verifySecondFactor(user, { code, recoveryCode }))) {
      await fail();
      throw new InvalidTwoFactorCodeError();
    }
  }

  await clearAccount(email);
  return { id: user.id, email: user.email, name: user.name, rememberMe: isChecked(rawRememberMe) };
}
