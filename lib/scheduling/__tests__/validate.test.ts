import { describe, expect, test } from "vitest";
import { MAX_RANGE_DAYS, parseRange, parseScheduleTime } from "../validate";

const NOW = new Date("2026-09-16T12:00:00Z");

describe("parseScheduleTime", () => {
  test("accepts a future time and returns it as a UTC instant plus the zone", () => {
    const result = parseScheduleTime({ date: "2026-09-20", time: "14:30", timezone: "Europe/Istanbul" }, NOW);
    expect(result).toEqual({
      ok: true,
      scheduledAt: new Date("2026-09-20T11:30:00Z"),
      timezone: "Europe/Istanbul",
    });
  });

  test("rejects a time in the past", () => {
    const result = parseScheduleTime({ date: "2026-09-15", time: "09:00", timezone: "UTC" }, NOW);
    expect(result).toEqual({ ok: false, error: expect.stringMatching(/in the past/) });
  });

  test("rejects a time one minute ago, and exactly now", () => {
    expect(parseScheduleTime({ date: "2026-09-16", time: "11:59", timezone: "UTC" }, NOW).ok).toBe(false);
    expect(parseScheduleTime({ date: "2026-09-16", time: "12:00", timezone: "UTC" }, NOW).ok).toBe(false);
    expect(parseScheduleTime({ date: "2026-09-16", time: "12:01", timezone: "UTC" }, NOW).ok).toBe(true);
  });

  test("past-ness is judged in the chosen timezone, not the server's", () => {
    // 14:30 in Istanbul is 11:30 UTC — already gone at NOW (12:00 UTC)...
    expect(parseScheduleTime({ date: "2026-09-16", time: "14:30", timezone: "Europe/Istanbul" }, NOW).ok).toBe(false);
    // ...while 14:30 in New York is 18:30 UTC, still ahead.
    const ny = parseScheduleTime({ date: "2026-09-16", time: "14:30", timezone: "America/New_York" }, NOW);
    expect(ny).toEqual({ ok: true, scheduledAt: new Date("2026-09-16T18:30:00Z"), timezone: "America/New_York" });
  });

  test("rejects a wall time skipped by daylight saving with an explanation", () => {
    const result = parseScheduleTime(
      { date: "2027-03-14", time: "02:30", timezone: "America/New_York" },
      NOW,
    );
    expect(result).toEqual({ ok: false, error: expect.stringMatching(/doesn't exist in America\/New_York/) });
  });

  test.each([
    [{ date: "2026-09-20", time: "14:30" }, /timezone/],
    [{ date: "2026-09-20", time: "14:30", timezone: "Nowhere/City" }, /timezone/],
    [{ time: "14:30", timezone: "UTC" }, /date and time/],
    [{ date: "2026-09-20", timezone: "UTC" }, /date and time/],
    [{ date: "20/09/2026", time: "14:30", timezone: "UTC" }, /valid date and time/],
    [null, /timezone/],
  ])("rejects malformed body %j", (body, message) => {
    expect(parseScheduleTime(body, NOW)).toEqual({ ok: false, error: expect.stringMatching(message) });
  });
});

describe("parseRange", () => {
  test("parses a [from, to) pair of ISO timestamps", () => {
    expect(parseRange("2026-09-14T00:00:00.000Z", "2026-09-28T00:00:00.000Z")).toEqual({
      ok: true,
      from: new Date("2026-09-14T00:00:00Z"),
      to: new Date("2026-09-28T00:00:00Z"),
    });
  });

  test("rejects missing, unparseable, reversed, empty and oversized ranges", () => {
    expect(parseRange(null, "2026-09-28T00:00:00Z").ok).toBe(false);
    expect(parseRange("2026-09-14T00:00:00Z", null).ok).toBe(false);
    expect(parseRange("yesterday", "2026-09-28T00:00:00Z").ok).toBe(false);
    expect(parseRange("2026-09-28T00:00:00Z", "2026-09-14T00:00:00Z").ok).toBe(false);
    expect(parseRange("2026-09-14T00:00:00Z", "2026-09-14T00:00:00Z").ok).toBe(false);
    const from = new Date("2026-01-01T00:00:00Z");
    const tooFar = new Date(from.getTime() + (MAX_RANGE_DAYS + 1) * 86_400_000);
    expect(parseRange(from.toISOString(), tooFar.toISOString()).ok).toBe(false);
  });
});
