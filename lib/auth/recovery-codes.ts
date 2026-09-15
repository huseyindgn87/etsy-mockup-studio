import { createHash, randomBytes } from "node:crypto";
import { RECOVERY_CODE_COUNT } from "./two-factor-codes";

/** 32 symbols (5 bits each), no look-alikes (0/O, 1/I). */
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 10;

/** One code, formatted `XXXXX-XXXXX` — 50 bits of randomness. */
export function generateRecoveryCode(): string {
  const chars = [...randomBytes(CODE_LENGTH)].map((b) => ALPHABET[b & 31]).join("");
  return `${chars.slice(0, 5)}-${chars.slice(5)}`;
}

/** A full set of distinct codes. */
export function generateRecoveryCodes(count: number = RECOVERY_CODE_COUNT): string[] {
  const codes = new Set<string>();
  while (codes.size < count) codes.add(generateRecoveryCode());
  return [...codes];
}

/** Case, spaces and the dash don't matter when a user types a code back in. */
export function normalizeRecoveryCode(input: string): string {
  return input.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export function isWellFormedRecoveryCode(input: string): boolean {
  const normalized = normalizeRecoveryCode(input);
  return normalized.length === CODE_LENGTH && [...normalized].every((c) => ALPHABET.includes(c));
}

/**
 * SHA-256 of the normalized code. A fast hash is appropriate here (unlike for
 * passwords): each code is 50 random bits, not a human-chosen secret, and a
 * deterministic hash lets a sign-in look the code up with one indexed query.
 */
export function hashRecoveryCode(code: string): string {
  return createHash("sha256").update(normalizeRecoveryCode(code)).digest("hex");
}
