/**
 * Wall-clock ⇄ UTC conversion for listing scheduling, on nothing but `Intl`
 * (no date library). Dependency-free, so the editor's schedule picker, the
 * /schedule screen and the API routes all share one implementation.
 *
 * A wall time is a `"YYYY-MM-DD"` date plus an `"HH:mm"` time in an IANA
 * timezone — exactly what `<input type="date">` / `<input type="time">`
 * produce. The instant it names is what gets stored (`scheduledAt`, UTC).
 */

export interface WallTime {
  /** `"YYYY-MM-DD"` */
  date: string;
  /** `"HH:mm"`, 24-hour */
  time: string;
}

export type WallTimeToUtcResult =
  | { ok: true; instant: Date }
  /** `invalid`: malformed date/time or unknown timezone. `nonexistent`: the
   * wall time falls in a daylight-saving gap (e.g. 02:30 on a spring-forward
   * night), so no instant has that local time. */
  | { ok: false; reason: "invalid" | "nonexistent" };

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_RE = /^(\d{2}):(\d{2})$/;
const DAY_MS = 24 * 60 * 60 * 1000;

export function isValidTimeZone(timeZone: unknown): timeZone is string {
  if (typeof timeZone !== "string" || timeZone === "" || timeZone.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(timeZone, f);
  }
  return f;
}

interface Fields {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function fieldsAt(ms: number, timeZone: string): Fields {
  const out: Record<string, number> = {};
  for (const part of formatterFor(timeZone).formatToParts(new Date(ms))) {
    if (part.type !== "literal") out[part.type] = Number(part.value);
  }
  return {
    year: out.year,
    month: out.month,
    day: out.day,
    hour: out.hour,
    minute: out.minute,
    second: out.second,
  };
}

/** How far `timeZone`'s wall clock is ahead of UTC at instant `ms`, in milliseconds. */
function offsetAt(ms: number, timeZone: string): number {
  const f = fieldsAt(ms, timeZone);
  const asUtc = Date.UTC(f.year, f.month - 1, f.day, f.hour, f.minute, f.second);
  return asUtc - (ms - (((ms % 1000) + 1000) % 1000));
}

const pad = (n: number, width = 2) => String(n).padStart(width, "0");

/** The wall time an instant shows in `timeZone`. Throws on an unknown timezone. */
export function utcToWallTime(instant: Date, timeZone: string): WallTime {
  const f = fieldsAt(instant.getTime(), timeZone);
  return {
    date: `${pad(f.year, 4)}-${pad(f.month)}-${pad(f.day)}`,
    time: `${pad(f.hour)}:${pad(f.minute)}`,
  };
}

/**
 * The UTC instant at which `timeZone`'s clock reads `date` `time`.
 *
 * Offsets are sampled a day either side of the target, which brackets any
 * real-world transition; each resulting candidate is kept only if it really
 * shows the requested wall time. An ambiguous time (repeated when clocks go
 * back) resolves to its earlier occurrence; a time skipped when clocks go
 * forward has no candidate and is reported as `nonexistent`.
 */
export function wallTimeToUtc(date: string, time: string, timeZone: string): WallTimeToUtcResult {
  const d = DATE_RE.exec(typeof date === "string" ? date : "");
  const t = TIME_RE.exec(typeof time === "string" ? time : "");
  if (!d || !t || !isValidTimeZone(timeZone)) return { ok: false, reason: "invalid" };

  const [year, month, day] = [Number(d[1]), Number(d[2]), Number(d[3])];
  const [hour, minute] = [Number(t[1]), Number(t[2])];
  if (month < 1 || month > 12 || hour > 23 || minute > 59) return { ok: false, reason: "invalid" };

  const local = Date.UTC(year, month - 1, day, hour, minute);
  // Date.UTC rolls Feb 30 over into March — reject rather than silently shift.
  const check = new Date(local);
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) {
    return { ok: false, reason: "invalid" };
  }

  const wanted = `${date} ${time}`;
  const candidates = [...new Set([offsetAt(local - DAY_MS, timeZone), offsetAt(local + DAY_MS, timeZone)])]
    .map((offset) => local - offset)
    .filter((ms) => {
      const wall = utcToWallTime(new Date(ms), timeZone);
      return `${wall.date} ${wall.time}` === wanted;
    })
    .sort((a, b) => a - b);

  if (candidates.length === 0) return { ok: false, reason: "nonexistent" };
  return { ok: true, instant: new Date(candidates[0]) };
}
