/**
 * Request validation for the scheduling API — pure, so the rules (and the
 * messages the editor shows) are unit-testable without a route or a DB.
 */

import { isValidTimeZone, wallTimeToUtc } from "./timezone";

export type ParsedScheduleTime =
  | { ok: true; scheduledAt: Date; timezone: string }
  | { ok: false; error: string };

/** The widest date range one list request may ask for. The /schedule screen asks for 14 days. */
export const MAX_RANGE_DAYS = 62;

/**
 * Turns a `{ date, time, timezone }` body into the UTC instant to store.
 * Rejects malformed input, unknown timezones, wall times skipped by a
 * daylight-saving change, and anything not strictly after `now`.
 */
export function parseScheduleTime(body: unknown, now: Date = new Date()): ParsedScheduleTime {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  if (!isValidTimeZone(b.timezone)) {
    return { ok: false, error: "Choose a valid timezone." };
  }
  if (typeof b.date !== "string" || typeof b.time !== "string") {
    return { ok: false, error: "Choose a date and time." };
  }

  const result = wallTimeToUtc(b.date, b.time, b.timezone);
  if (!result.ok) {
    return {
      ok: false,
      error:
        result.reason === "nonexistent"
          ? `${b.date} ${b.time} doesn't exist in ${b.timezone} (clocks change that night). Choose another time.`
          : "Choose a valid date and time.",
    };
  }
  if (result.instant.getTime() <= now.getTime()) {
    return { ok: false, error: "That time is in the past. Choose a time in the future." };
  }
  return { ok: true, scheduledAt: result.instant, timezone: b.timezone };
}

export type ParsedRange = { ok: true; from: Date; to: Date } | { ok: false; error: string };

/** A `[from, to)` range from two ISO 8601 query params. */
export function parseRange(from: string | null, to: string | null): ParsedRange {
  if (!from || !to) return { ok: false, error: "Both `from` and `to` are required." };
  const fromDate = new Date(from);
  const toDate = new Date(to);
  if (Number.isNaN(fromDate.getTime()) || Number.isNaN(toDate.getTime())) {
    return { ok: false, error: "`from` and `to` must be ISO 8601 timestamps." };
  }
  if (toDate.getTime() <= fromDate.getTime()) {
    return { ok: false, error: "`to` must be after `from`." };
  }
  if (toDate.getTime() - fromDate.getTime() > MAX_RANGE_DAYS * 24 * 60 * 60 * 1000) {
    return { ok: false, error: `A range can span at most ${MAX_RANGE_DAYS} days.` };
  }
  return { ok: true, from: fromDate, to: toDate };
}
