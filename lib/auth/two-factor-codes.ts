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
