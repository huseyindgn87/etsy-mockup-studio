/**
 * Client-safe constants shared by the sign-in flow (app/login/page.tsx) and
 * the server (lib/auth/two-factor-errors.ts). The two codes travel back to
 * `signIn()` in Auth.js's `code` query parameter.
 */

/** The password was right; the account has 2FA on and no code was sent. */
export const TWO_FACTOR_REQUIRED = "two_factor_required";

/** A code or recovery code was sent but didn't verify (wrong, expired, reused). */
export const INVALID_TWO_FACTOR_CODE = "invalid_two_factor_code";

export const RECOVERY_CODE_COUNT = 10;

/**
 * Brute-force limits (lib/auth/throttle.ts). The two timed codes carry the
 * epoch ms the lock ends, as `<code>:<ms>`. None of them depends on whether
 * an account has the email.
 */
export const ACCOUNT_LOCKED = "account_locked";
export const IP_RATE_LIMITED = "rate_limited";
export const EMAIL_VERIFICATION_LOCKED = "email_verification_locked";
export const HUMAN_CHECK_REQUIRED = "human_check_required";
export const HUMAN_CHECK_FAILED = "human_check_failed";

export function timedCode(code: string, until: Date): string {
  return `${code}:${until.getTime()}`;
}

/** Splits a `<code>:<ms>` code; `until` is null for a code without a time. */
export function parseSignInCode(raw: string | undefined | null): { code: string; until: Date | null } {
  const [code = "", ms] = (raw ?? "").split(":");
  const time = Number(ms);
  return { code, until: ms && Number.isFinite(time) ? new Date(time) : null };
}
