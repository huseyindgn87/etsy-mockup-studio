import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";

/**
 * Encrypted cookie session for Etsy OAuth tokens.
 *
 * Token set is serialized to JSON and sealed with AES-256-GCM. The key is
 * derived from the app secret via SHA-256. Format of the cookie value:
 *
 *   base64url(iv).base64url(ciphertext).base64url(authTag)
 */

export const SESSION_COOKIE = "etsy_session";
export const STATE_COOKIE = "etsy_oauth_state";
export const VERIFIER_COOKIE = "etsy_pkce_verifier";

/** Refresh tokens are valid ~90 days; keep the cookie alive that long. */
export const SESSION_MAX_AGE_SECONDS = 90 * 24 * 60 * 60;

export interface EtsySession {
  accessToken: string;
  refreshToken: string;
  /** Epoch milliseconds when the access token expires. */
  expiresAt: number;
  /** Etsy user id (the numeric prefix of the access token). */
  userId: string;
}

function keyFrom(secret: string): Buffer {
  return createHash("sha256").update(secret).digest();
}

function b64url(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function fromB64url(s: string): Buffer {
  return Buffer.from(s, "base64url");
}

export function sealSession(session: EtsySession, secret: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyFrom(secret), iv);
  const plaintext = Buffer.from(JSON.stringify(session), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${b64url(iv)}.${b64url(ciphertext)}.${b64url(tag)}`;
}

export function openSession(
  value: string | undefined,
  secret: string,
): EtsySession | null {
  if (!value) return null;
  const parts = value.split(".");
  if (parts.length !== 3) return null;
  try {
    const [iv, ciphertext, tag] = parts.map(fromB64url);
    const decipher = createDecipheriv("aes-256-gcm", keyFrom(secret), iv);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]);
    const parsed = JSON.parse(plaintext.toString("utf8")) as EtsySession;
    if (
      typeof parsed.accessToken === "string" &&
      typeof parsed.refreshToken === "string" &&
      typeof parsed.expiresAt === "number" &&
      typeof parsed.userId === "string"
    ) {
      return parsed;
    }
    return null;
  } catch {
    // Tampered, truncated, or sealed with an old secret.
    return null;
  }
}
