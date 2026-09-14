import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";

/**
 * AES-256-GCM encrypt/decrypt for a single secret string — used to store an
 * `EtsyShopConnection`'s refresh token at rest in the DB. Same scheme as
 * lib/etsy/session.ts's cookie sealing (same `ETSY_OAUTH_SESSION_SECRET`
 * key), kept as its own small module rather than shared code: a DB-persisted
 * token and a short-lived cookie session are different concerns even though
 * the underlying cipher is identical.
 *
 * Format: base64url(iv).base64url(ciphertext).base64url(authTag)
 */

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

export function encryptToken(plain: string, secret: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyFrom(secret), iv);
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.from(plain, "utf8")),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return `${b64url(iv)}.${b64url(ciphertext)}.${b64url(tag)}`;
}

/** Throws if `sealed` is malformed or was encrypted with a different secret. */
export function decryptToken(sealed: string, secret: string): string {
  const parts = sealed.split(".");
  if (parts.length !== 3) throw new Error("Malformed encrypted token.");
  const [iv, ciphertext, tag] = parts.map(fromB64url);
  const decipher = createDecipheriv("aes-256-gcm", keyFrom(secret), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}
