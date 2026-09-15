import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * TOTP (RFC 6238) on top of HOTP (RFC 4226), with the parameters every
 * authenticator app (Google Authenticator, Authy, 1Password…) assumes by
 * default: HMAC-SHA1, 6 digits, 30-second steps. Implemented on `node:crypto`
 * directly — no third-party service or library involved.
 */

export const TOTP_PERIOD_SECONDS = 30;
export const TOTP_DIGITS = 6;
/** Accept the previous and next step too, to tolerate clock drift and typing time. */
export const TOTP_WINDOW_STEPS = 1;

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** RFC 4648 base32, no padding — the format authenticator apps expect for secrets. */
export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    value &= (1 << bits) - 1;
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/** Tolerates lowercase, spaces, dashes and `=` padding. Throws on any other character. */
export function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/[\s=-]/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx === -1) throw new Error("Invalid base32 character.");
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
    value &= (1 << bits) - 1;
  }
  return Buffer.from(out);
}

/** A new random 160-bit secret (RFC 4226's recommended length), base32-encoded. */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

export function timeStep(nowMs: number = Date.now()): number {
  return Math.floor(nowMs / 1000 / TOTP_PERIOD_SECONDS);
}

export function hotp(key: Buffer, counter: number, digits: number = TOTP_DIGITS): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac("sha1", key).update(msg).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const binary =
    ((mac[offset] & 0x7f) << 24) |
    (mac[offset + 1] << 16) |
    (mac[offset + 2] << 8) |
    mac[offset + 3];
  return String(binary % 10 ** digits).padStart(digits, "0");
}

/** The code an authenticator app shows for `secret` at `nowMs`. */
export function totpAt(secretBase32: string, nowMs: number = Date.now()): string {
  return hotp(base32Decode(secretBase32), timeStep(nowMs));
}

/**
 * Checks a 6-digit code against `secret` within ±{@link TOTP_WINDOW_STEPS}
 * steps. Returns the matching time step (callers use it for replay
 * protection), or `null` if it doesn't match. Constant-time per comparison.
 */
export function verifyTotp(secretBase32: string, code: string, nowMs: number = Date.now()): number | null {
  const candidate = code.replace(/\s+/g, "");
  if (!new RegExp(`^\\d{${TOTP_DIGITS}}$`).test(candidate)) return null;

  const key = base32Decode(secretBase32);
  const current = timeStep(nowMs);
  let matched: number | null = null;
  for (let offset = -TOTP_WINDOW_STEPS; offset <= TOTP_WINDOW_STEPS; offset++) {
    const step = current + offset;
    if (step < 0) continue;
    if (timingSafeEqual(Buffer.from(hotp(key, step)), Buffer.from(candidate))) matched = step;
  }
  return matched;
}

/** The `otpauth://` URI encoded into the setup QR code (Key Uri Format). */
export function otpauthUri({
  secret,
  accountName,
  issuer,
}: {
  secret: string;
  accountName: string;
  issuer: string;
}): string {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(accountName)}`;
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: "SHA1",
    digits: String(TOTP_DIGITS),
    period: String(TOTP_PERIOD_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}
