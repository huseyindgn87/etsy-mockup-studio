import { describe, expect, test } from "vitest";
import { describeJob } from "../describe";
import type { JobView } from "../types";

const view = (over: Partial<JobView>): JobView => ({
  id: "j1",
  type: "bulk_save",
  status: "queued",
  priority: 0,
  position: null,
  attempts: 0,
  maxAttempts: 3,
  progress: null,
  error: null,
  result: null,
  runAfter: "2026-09-18T14:05:00.000Z",
  createdAt: "2026-09-18T14:00:00.000Z",
  finishedAt: null,
  ...over,
});

describe("describeJob — what the user reads instead of a spinner", () => {
  test("queued, with its place in line", () => {
    expect(describeJob(view({ position: 1 }))).toBe("Queued — next in line");
    expect(describeJob(view({ position: 3 }))).toBe("Queued — 3rd in line");
    expect(describeJob(view({ position: 12 }))).toBe("Queued — 12th in line");
    expect(describeJob(view({ position: 2, error: "Etsy limit reached, try again after 13:00 UTC." }))).toBe(
      "Queued — 2nd in line. Etsy limit reached, try again after 13:00 UTC.",
    );
  });

  test("running, with progress when it's known", () => {
    expect(describeJob(view({ status: "running", progress: { done: 5, total: 40, message: null } }))).toBe("Running — 5 of 40");
    expect(describeJob(view({ status: "running", progress: { done: null, total: null, message: "Fetching listings" } }))).toBe(
      "Running — Fetching listings",
    );
    expect(describeJob(view({ status: "running" }))).toBe("Running");
  });

  test("done, failed with the reason, retrying with when", () => {
    expect(describeJob(view({ status: "done" }))).toBe("Done");
    expect(describeJob(view({ status: "failed", error: "Listing not found." }))).toBe("Failed: Listing not found.");
    expect(describeJob(view({ status: "retrying", error: "timeout" }))).toBe("Retrying at 14:05 UTC — timeout");
  });
});
