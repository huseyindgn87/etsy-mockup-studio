import { describe, expect, test } from "vitest";
import { isValidTimeZone, utcToWallTime, wallTimeToUtc } from "../timezone";

function toUtc(date: string, time: string, tz: string): string {
  const result = wallTimeToUtc(date, time, tz);
  if (!result.ok) throw new Error(`expected ${date} ${time} ${tz} to convert, got ${result.reason}`);
  return result.instant.toISOString();
}

describe("wallTimeToUtc — a wall time in a timezone becomes the right UTC instant", () => {
  test.each([
    ["UTC", "2026-09-20", "14:30", "2026-09-20T14:30:00.000Z"],
    ["Europe/Istanbul", "2026-09-20", "14:30", "2026-09-20T11:30:00.000Z"],
    // Same zone, both sides of daylight saving.
    ["America/New_York", "2026-07-01", "09:00", "2026-07-01T13:00:00.000Z"],
    ["America/New_York", "2026-01-15", "09:00", "2026-01-15T14:00:00.000Z"],
    ["Europe/London", "2026-07-01", "09:00", "2026-07-01T08:00:00.000Z"],
    ["Europe/London", "2026-12-01", "09:00", "2026-12-01T09:00:00.000Z"],
    // Half-hour offset, crossing back into the previous UTC day.
    ["Asia/Kolkata", "2026-03-01", "00:15", "2026-02-28T18:45:00.000Z"],
    // Southern hemisphere: DST in January.
    ["Australia/Sydney", "2026-01-10", "08:00", "2026-01-09T21:00:00.000Z"],
    // Ahead of UTC by more than 12 hours, crossing a year boundary.
    ["Pacific/Kiritimati", "2027-01-01", "00:00", "2026-12-31T10:00:00.000Z"],
  ])("%s %s %s → %s", (tz, date, time, expected) => {
    expect(toUtc(date, time, tz)).toBe(expected);
  });

  test("a time skipped when clocks go forward is reported as nonexistent", () => {
    // US DST starts 2026-03-08 at 02:00 → 03:00.
    expect(wallTimeToUtc("2026-03-08", "02:30", "America/New_York")).toEqual({
      ok: false,
      reason: "nonexistent",
    });
    // UK: 2026-03-29 at 01:00 → 02:00.
    expect(wallTimeToUtc("2026-03-29", "01:30", "Europe/London")).toEqual({
      ok: false,
      reason: "nonexistent",
    });
    // The minutes either side of the gap are fine.
    expect(toUtc("2026-03-08", "01:59", "America/New_York")).toBe("2026-03-08T06:59:00.000Z");
    expect(toUtc("2026-03-08", "03:00", "America/New_York")).toBe("2026-03-08T07:00:00.000Z");
  });

  test("a time repeated when clocks go back resolves to its first occurrence", () => {
    // US DST ends 2026-11-01 at 02:00 → 01:00; 01:30 happens twice (EDT, then EST).
    expect(toUtc("2026-11-01", "01:30", "America/New_York")).toBe("2026-11-01T05:30:00.000Z");
  });

  test.each([
    ["2026-02-30", "10:00", "UTC"],
    ["2026-13-01", "10:00", "UTC"],
    ["2026-9-1", "10:00", "UTC"],
    ["2026-09-01", "24:00", "UTC"],
    ["2026-09-01", "10:60", "UTC"],
    ["2026-09-01", "10:00:00", "UTC"],
    ["2026-09-01", "10:00", "Mars/Olympus_Mons"],
    ["2026-09-01", "10:00", ""],
  ])("rejects malformed input %s %s %s", (date, time, tz) => {
    expect(wallTimeToUtc(date, time, tz)).toEqual({ ok: false, reason: "invalid" });
  });
});

describe("utcToWallTime — and back again", () => {
  test("shows an instant as the wall time in the given zone", () => {
    const instant = new Date("2026-09-20T11:30:00Z");
    expect(utcToWallTime(instant, "Europe/Istanbul")).toEqual({ date: "2026-09-20", time: "14:30" });
    expect(utcToWallTime(instant, "America/Los_Angeles")).toEqual({ date: "2026-09-20", time: "04:30" });
    expect(utcToWallTime(instant, "Pacific/Auckland")).toEqual({ date: "2026-09-20", time: "23:30" });
    expect(utcToWallTime(instant, "Pacific/Honolulu")).toEqual({ date: "2026-09-20", time: "01:30" });
  });

  test("midnight is 00:00, not 24:00", () => {
    expect(utcToWallTime(new Date("2026-09-20T00:00:00Z"), "UTC")).toEqual({ date: "2026-09-20", time: "00:00" });
  });

  test("UTC → wall time → UTC round-trips across zones and a whole year", () => {
    const zones = [
      "UTC",
      "Europe/Istanbul",
      "Europe/London",
      "America/New_York",
      "America/Sao_Paulo",
      "Asia/Kolkata",
      "Asia/Kathmandu",
      "Australia/Adelaide",
      "Pacific/Chatham",
    ];
    const start = Date.UTC(2026, 0, 1, 0, 0);
    for (const tz of zones) {
      // Every ~37 hours through 2026, so each day of the week and hour gets hit.
      for (let ms = start; ms < start + 366 * 86_400_000; ms += 37 * 3_600_000 + 17 * 60_000) {
        const instant = new Date(ms);
        const wall = utcToWallTime(instant, tz);
        const back = wallTimeToUtc(wall.date, wall.time, tz);
        expect(back.ok, `${tz} ${instant.toISOString()}`).toBe(true);
        if (!back.ok) continue;
        // The only legitimate mismatch is a repeated (clocks-back) hour, which
        // resolves to the first occurrence — an hour or less earlier.
        const drift = instant.getTime() - back.instant.getTime();
        expect([0, 30 * 60_000, 60 * 60_000], `${tz} ${instant.toISOString()}`).toContain(drift);
        expect(utcToWallTime(back.instant, tz)).toEqual(wall);
      }
    }
  });
});

describe("isValidTimeZone", () => {
  test("accepts IANA zones and rejects everything else", () => {
    expect(isValidTimeZone("Europe/Istanbul")).toBe(true);
    expect(isValidTimeZone("UTC")).toBe(true);
    expect(isValidTimeZone("Not/AZone")).toBe(false);
    expect(isValidTimeZone("")).toBe(false);
    expect(isValidTimeZone(undefined)).toBe(false);
    expect(isValidTimeZone(42)).toBe(false);
  });
});
