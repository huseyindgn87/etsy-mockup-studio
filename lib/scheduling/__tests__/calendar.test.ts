import { describe, expect, test } from "vitest";
import { addDays, formatRangeHeading, fortnightDays, localDayKey, startOfWeek } from "../calendar";

// All local-time dates — these helpers work in the viewer's own timezone.

describe("fortnight strip date math", () => {
  test("startOfWeek is local midnight on the Monday of that week", () => {
    const wednesday = new Date(2026, 8, 16, 15, 45); // Wed Sep 16 2026
    expect(startOfWeek(wednesday)).toEqual(new Date(2026, 8, 14));
    expect(startOfWeek(new Date(2026, 8, 14, 0, 0))).toEqual(new Date(2026, 8, 14)); // Monday itself
    expect(startOfWeek(new Date(2026, 8, 20, 23, 59))).toEqual(new Date(2026, 8, 14)); // Sunday
  });

  test("fortnightDays returns 14 consecutive local days, and adding 14 days pages exactly one fortnight", () => {
    const start = new Date(2026, 8, 14);
    const days = fortnightDays(start);
    expect(days).toHaveLength(14);
    expect(days.map(localDayKey)[0]).toBe("2026-09-14");
    expect(days.map(localDayKey)[13]).toBe("2026-09-27");
    expect(localDayKey(addDays(start, 14))).toBe("2026-09-28");
    expect(localDayKey(addDays(start, -14))).toBe("2026-08-31");
  });

  test("addDays stays on local midnight across month and year boundaries", () => {
    expect(addDays(new Date(2026, 11, 28), 7)).toEqual(new Date(2027, 0, 4));
    expect(addDays(new Date(2026, 1, 23), 7)).toEqual(new Date(2026, 2, 2));
  });

  test("formatRangeHeading names the visible range", () => {
    expect(formatRangeHeading(new Date(2026, 8, 14), "en-US")).toBe("Sep 14 – Sep 27, 2026");
    expect(formatRangeHeading(new Date(2026, 11, 28), "en-US")).toBe("Dec 28, 2026 – Jan 10, 2027");
  });
});
