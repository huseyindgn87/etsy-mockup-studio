import type { ThrottleRow, ThrottleStore } from "../throttle-store";

/** An in-memory ThrottleStore for tests — the same semantics as the Prisma one. */
export function createMemoryThrottleStore(): ThrottleStore & { rows: Map<string, ThrottleRow> } {
  const rows = new Map<string, ThrottleRow>();
  const blank = (key: string, now = new Date()): ThrottleRow => ({
    key,
    failures: 0,
    lockLevel: 0,
    lockedUntil: null,
    emailLocked: false,
    windowStart: now,
  });
  return {
    rows,
    async get(key) {
      const row = rows.get(key);
      return row ? { ...row } : null;
    },
    async increment(key, now) {
      const row = rows.get(key) ?? blank(key, now);
      row.failures += 1;
      rows.set(key, row);
      return { ...row };
    },
    async updateIfFailuresAtLeast(key, minFailures, patch) {
      const row = rows.get(key);
      if (!row || row.failures < minFailures) return false;
      Object.assign(row, patch);
      return true;
    },
    async set(key, patch) {
      rows.set(key, { ...(rows.get(key) ?? blank(key)), ...patch });
    },
    async delete(key) {
      rows.delete(key);
    },
  };
}
