import { prisma } from "@/lib/db/prisma";

/**
 * Storage for lib/auth/throttle.ts — one `auth_throttles` row per key, in the
 * database so every serverless instance sees the same counters. Kept behind
 * this small interface so the policy is testable without Prisma.
 */

export interface ThrottleRow {
  key: string;
  failures: number;
  lockLevel: number;
  lockedUntil: Date | null;
  emailLocked: boolean;
  windowStart: Date;
}

export type ThrottlePatch = Partial<Omit<ThrottleRow, "key">>;

export interface ThrottleStore {
  get(key: string): Promise<ThrottleRow | null>;
  /** Adds one failure atomically, creating the row (window starting `now`) if missing; returns the row after. */
  increment(key: string, now: Date): Promise<ThrottleRow>;
  /** Applies `patch` only while the row still has at least `minFailures` — so two concurrent failures can't both lock. */
  updateIfFailuresAtLeast(key: string, minFailures: number, patch: ThrottlePatch): Promise<boolean>;
  set(key: string, patch: ThrottlePatch): Promise<void>;
  delete(key: string): Promise<void>;
}

export const prismaThrottleStore: ThrottleStore = {
  get: (key) => prisma.authThrottle.findUnique({ where: { key } }),
  increment: (key, now) =>
    prisma.authThrottle.upsert({
      where: { key },
      create: { key, failures: 1, windowStart: now },
      update: { failures: { increment: 1 } },
    }),
  async updateIfFailuresAtLeast(key, minFailures, patch) {
    const { count } = await prisma.authThrottle.updateMany({
      where: { key, failures: { gte: minFailures } },
      data: patch,
    });
    return count === 1;
  },
  async set(key, patch) {
    await prisma.authThrottle.upsert({ where: { key }, create: { key, ...patch }, update: patch });
  },
  async delete(key) {
    await prisma.authThrottle.deleteMany({ where: { key } });
  },
};
