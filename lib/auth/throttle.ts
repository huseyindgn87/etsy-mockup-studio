import { createHash } from "node:crypto";
import { prismaThrottleStore, type ThrottleStore } from "./throttle-store";

/**
 * Brute-force limits for sign-in, 2FA codes and registration. Counters live
 * in the database (lib/auth/throttle-store.ts).
 *
 * Per account: every 3 failed attempts (wrong password or wrong 2FA code)
 * lock it — 3 minutes, then 15, then 1 hour, at which point it also stays
 * locked until the owner verifies by email. A successful sign-in clears it.
 * Once an account has been locked, every attempt on it needs a passed
 * Turnstile check. The key is the email's hash whether or not an account has
 * that email, so the limits behave identically for unknown addresses.
 *
 * Per IP: 20 failed sign-ins per 15 minutes; 5 sign-ups per hour.
 */

export const FAILURES_PER_LOCK = 3;
export const LOCK_DURATIONS_MS = [3 * 60_000, 15 * 60_000, 60 * 60_000] as const;
/** The lock level (1-based) from which the account also needs email verification. */
export const EMAIL_LOCK_LEVEL = LOCK_DURATIONS_MS.length;

export const IP_LOGIN_FAILURE_LIMIT = 20;
export const IP_LOGIN_WINDOW_MS = 15 * 60_000;
export const IP_REGISTRATION_LIMIT = 5;
export const IP_REGISTRATION_WINDOW_MS = 60 * 60_000;

let store: ThrottleStore = prismaThrottleStore;

/** Tests only. */
export function setThrottleStore(next: ThrottleStore): void {
  store = next;
}

export function lockDurationMs(level: number): number {
  return LOCK_DURATIONS_MS[Math.min(level, LOCK_DURATIONS_MS.length) - 1];
}

export function accountKey(email: string): string {
  return `login:${createHash("sha256").update(email).digest("hex")}`;
}

export type AccountGate =
  | { kind: "open"; humanCheck: boolean }
  | { kind: "locked"; until: Date }
  | { kind: "email_locked" };

export type WindowGate = { ok: true } | { ok: false; until: Date };

export async function checkAccount(email: string, now: Date = new Date()): Promise<AccountGate> {
  const row = await store.get(accountKey(email));
  if (!row) return { kind: "open", humanCheck: false };
  if (row.emailLocked) return { kind: "email_locked" };
  if (row.lockedUntil && row.lockedUntil > now) return { kind: "locked", until: row.lockedUntil };
  return { kind: "open", humanCheck: row.lockLevel > 0 };
}

/** Records one failed attempt; returns the account's state after it (locked when this was the 3rd). */
export async function recordAccountFailure(email: string, now: Date = new Date()): Promise<AccountGate> {
  const key = accountKey(email);
  const row = await store.increment(key, now);
  if (row.failures < FAILURES_PER_LOCK) return { kind: "open", humanCheck: row.lockLevel > 0 };

  const level = row.lockLevel + 1;
  const until = new Date(now.getTime() + lockDurationMs(level));
  const emailLocked = level >= EMAIL_LOCK_LEVEL;
  const locked = await store.updateIfFailuresAtLeast(key, FAILURES_PER_LOCK, {
    failures: 0,
    lockLevel: level,
    lockedUntil: until,
    emailLocked,
  });
  if (!locked) return checkAccount(email, now);
  return emailLocked ? { kind: "email_locked" } : { kind: "locked", until };
}

export async function clearAccount(email: string): Promise<void> {
  await store.delete(accountKey(email));
}

async function checkWindow(key: string, limit: number, windowMs: number, now: Date): Promise<WindowGate> {
  const row = await store.get(key);
  if (!row || row.windowStart.getTime() + windowMs <= now.getTime()) return { ok: true };
  if (row.failures < limit) return { ok: true };
  return { ok: false, until: new Date(row.windowStart.getTime() + windowMs) };
}

async function hitWindow(key: string, windowMs: number, now: Date): Promise<void> {
  const row = await store.increment(key, now);
  if (row.windowStart.getTime() + windowMs <= now.getTime()) {
    await store.set(key, { failures: 1, windowStart: now });
  }
}

export function checkIpLogin(ip: string, now: Date = new Date()): Promise<WindowGate> {
  return checkWindow(`login-ip:${ip}`, IP_LOGIN_FAILURE_LIMIT, IP_LOGIN_WINDOW_MS, now);
}

export function recordIpLoginFailure(ip: string, now: Date = new Date()): Promise<void> {
  return hitWindow(`login-ip:${ip}`, IP_LOGIN_WINDOW_MS, now);
}

/** Counts a sign-up from `ip` if it's under the hourly limit. */
export async function takeRegistrationSlot(ip: string, now: Date = new Date()): Promise<WindowGate> {
  const key = `register-ip:${ip}`;
  const gate = await checkWindow(key, IP_REGISTRATION_LIMIT, IP_REGISTRATION_WINDOW_MS, now);
  if (gate.ok) await hitWindow(key, IP_REGISTRATION_WINDOW_MS, now);
  return gate;
}

/** The caller's IP as the hosting proxy reports it; "unknown" when no header carries one. */
export function clientIp(headers: Headers | undefined): string {
  const forwarded = headers?.get("x-forwarded-for")?.split(",")[0]?.trim();
  return headers?.get("cf-connecting-ip")?.trim() || headers?.get("x-real-ip")?.trim() || forwarded || "unknown";
}
