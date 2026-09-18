// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import type { JobView } from "@/lib/jobs/types";
import { JobStatus } from "../JobStatus";

const view = (over: Partial<JobView>): JobView => ({
  id: "j1",
  type: "bulk_save",
  status: "queued",
  priority: 0,
  position: 4,
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

describe("JobStatus", () => {
  test("a queued job says its place in line", () => {
    render(<JobStatus job={view({})} />);
    expect(screen.getByRole("status")).toHaveTextContent("Queued — 4th in line");
  });

  test("a running job shows its count and a progress bar", () => {
    render(<JobStatus job={view({ status: "running", position: null, progress: { done: 5, total: 40, message: null } })} />);
    expect(screen.getByRole("status")).toHaveTextContent("Running — 5 of 40");
    expect(screen.getByRole("progressbar", { name: "Job progress" })).toHaveAttribute("value", "5");
  });

  test("a failed job is an alert with the reason", () => {
    render(<JobStatus job={view({ status: "failed", position: null, error: "Etsy refused the title." })} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Failed: Etsy refused the title.");
  });

  test("a finished job says Done", () => {
    render(<JobStatus job={view({ status: "done", position: null })} />);
    expect(screen.getByRole("status")).toHaveTextContent("Done");
  });
});
