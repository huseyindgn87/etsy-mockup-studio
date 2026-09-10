import { createHash, randomBytes } from "node:crypto";

/** base64url without padding (RFC 7636). */
function base64url(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export interface PkcePair {
  /** Send with the token exchange. Keep server-side only. */
  verifier: string;
  /** Send on the authorize redirect as `code_challenge`. */
  challenge: string;
}

/**
 * Create a PKCE verifier/challenge pair.
 * Etsy requires `code_challenge_method=S256`.
 */
export function createPkcePair(): PkcePair {
  // 32 random bytes -> 43-char base64url string (within the 43..128 spec range).
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

/** Opaque value to defend the callback against CSRF. */
export function createState(): string {
  return base64url(randomBytes(16));
}
