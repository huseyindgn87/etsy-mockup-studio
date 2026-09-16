/**
 * A key for "is this draft content the same as before?" — JSON with object
 * keys sorted, so two deep-equal values always produce the same string no
 * matter the order their keys were written in.
 */
export function draftSnapshotKey(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v,
  );
}
