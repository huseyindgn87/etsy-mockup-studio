/**
 * Date math for the /schedule screen's two-week strip. Everything here works
 * in the viewer's local time (the browser's timezone) — days are the
 * viewer's days, whatever timezone each listing was scheduled in.
 */

export const FORTNIGHT_DAYS = 14;

/** Midnight, local time, on the Monday of the week containing `date`. */
export function startOfWeek(date: Date): Date {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const sinceMonday = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - sinceMonday);
  return d;
}

/** `date` moved by `days` calendar days, keeping local midnight across DST changes. */
export function addDays(date: Date, days: number): Date {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  d.setDate(d.getDate() + days);
  return d;
}

/** The 14 local midnights starting at `start`. */
export function fortnightDays(start: Date): Date[] {
  return Array.from({ length: FORTNIGHT_DAYS }, (_, i) => addDays(start, i));
}

/** Local `"YYYY-MM-DD"` — the key a listing is grouped under. */
export function localDayKey(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** "Sep 14 – Sep 27, 2026", or "Dec 28, 2026 – Jan 10, 2027" across a year boundary. */
export function formatRangeHeading(start: Date, locale?: string): string {
  const end = addDays(start, FORTNIGHT_DAYS - 1);
  const monthDay: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" };
  const full: Intl.DateTimeFormatOptions = { ...monthDay, year: "numeric" };
  const sameYear = start.getFullYear() === end.getFullYear();
  const from = start.toLocaleDateString(locale, sameYear ? monthDay : full);
  const to = end.toLocaleDateString(locale, full);
  return `${from} – ${to}`;
}
