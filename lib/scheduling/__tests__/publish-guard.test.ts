import { describe, expect, test } from "vitest";
import { publishBlockedBySchedule, scheduleBlocker } from "../publish-guard";

describe("Publish is blocked while a draft is scheduled", () => {
  test("a pending schedule disables Publish and explains why", () => {
    expect(publishBlockedBySchedule({ status: "pending" })).toMatch(/scheduled to publish automatically/);
    expect(publishBlockedBySchedule({ status: "pending" })).toMatch(/duplicate listing/);
    expect(publishBlockedBySchedule({ status: "pending" })).toMatch(/Cancel the schedule/);
  });

  test("so does a schedule that's publishing right now", () => {
    expect(publishBlockedBySchedule({ status: "publishing" })).toMatch(/publishing it to Etsy right now/);
  });

  test("no schedule, or one that failed, was published or was cancelled, leaves Publish enabled", () => {
    expect(publishBlockedBySchedule(null)).toBeNull();
    expect(publishBlockedBySchedule({ status: "failed" })).toBeNull();
    expect(publishBlockedBySchedule({ status: "published" })).toBeNull();
    expect(publishBlockedBySchedule({ status: "cancelled" })).toBeNull();
  });
});

describe("what can be scheduled", () => {
  test("new listings and copies can; adding photos to an existing listing can't", () => {
    expect(scheduleBlocker({ publishMode: "new", videoCount: 0 })).toBeNull();
    expect(scheduleBlocker({ publishMode: "copy", videoCount: 0 })).toBeNull();
    expect(scheduleBlocker({ publishMode: "existing", videoCount: 0 })).toMatch(/existing listing can't be scheduled/);
  });

  test("a listing with a video can't be scheduled yet", () => {
    expect(scheduleBlocker({ publishMode: "new", videoCount: 1 })).toMatch(/video can't be scheduled/);
  });
});
