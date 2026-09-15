import { decryptToken, encryptToken } from "@/lib/etsy/token-crypto";

/**
 * Encryption at rest for TOTP secrets — the same AES-256-GCM scheme as an
 * `EtsyShopConnection`'s refresh token (lib/etsy/token-crypto.ts), but under
 * its own key, so rotating the Etsy session secret never breaks 2FA and vice
 * versa. Rotating this key invalidates every stored TOTP secret: affected
 * users sign in with a recovery code (those are hashed, not encrypted, so
 * they survive), then disable and re-enable 2FA.
 */

export const TWO_FACTOR_KEY_ENV = "TWO_FACTOR_ENCRYPTION_KEY";
const MIN_KEY_LENGTH = 32;

/** Missing or unusable `TWO_FACTOR_ENCRYPTION_KEY`. */
export class TwoFactorKeyError extends Error {
  name = "TwoFactorKeyError";
}

export function getTwoFactorKey(): string {
  const key = process.env[TWO_FACTOR_KEY_ENV];
  if (!key) {
    throw new TwoFactorKeyError(
      `Missing ${TWO_FACTOR_KEY_ENV} — the key that encrypts two-factor (TOTP) secrets at rest. ` +
        `Generate one with \`openssl rand -base64 32\` and add it to .env.local, then restart the server.`,
    );
  }
  if (key.length < MIN_KEY_LENGTH) {
    throw new TwoFactorKeyError(
      `${TWO_FACTOR_KEY_ENV} must be at least ${MIN_KEY_LENGTH} characters. Generate one with \`openssl rand -base64 32\`.`,
    );
  }
  return key;
}

export function encryptTwoFactorSecret(secret: string): string {
  return encryptToken(secret, getTwoFactorKey());
}

/** Throws if `sealed` was encrypted under a different key or is malformed. */
export function decryptTwoFactorSecret(sealed: string): string {
  return decryptToken(sealed, getTwoFactorKey());
}
