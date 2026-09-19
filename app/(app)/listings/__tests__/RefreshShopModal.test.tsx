// @vitest-environment jsdom
import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { JOB_STALL_MS, JOB_STALLED_MESSAGE, type JobView } from "@/lib/jobs/types";
import RefreshShopModal from "../RefreshShopModal";

const runningJob: JobView = {
  id: "job1",
  type: "listing_refresh",
  status: "running",
  priority: 0,
  position: null,
  attempts: 0,
  maxAttempts: 3,
  progress: { done: 10, total: 700, message: null },
  error: null,
  result: null,
  runAfter: "2026-09-19T07:00:00.000Z",
  createdAt: "2026-09-19T07:00:00.000Z",
  finishedAt: null,
};

const ndjson = (lines: unknown[], status = 200) =>
  new Response(lines.map((l) => `${JSON.stringify(l)}\n`).join(""), { status });

function stubFetch(refresh: () => Response) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url === "/api/etsy/shops") return new Response(JSON.stringify({ shops: [] }));
      if (url === "/api/etsy/shops/refresh") return refresh();
      if (url.startsWith("/api/jobs/job1")) return new Response(JSON.stringify({ job: runningJob }));
      throw new Error(`unexpected ${url}`);
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const renderModal = () => render(<RefreshShopModal open onClose={() => {}} onRefreshed={() => {}} />);

describe("RefreshShopModal", () => {
  test("a refresh that couldn't start shows an error instead of 'Preparing to refresh' forever", async () => {
    stubFetch(() => new Response(null, { status: 500 }));
    renderModal();
    expect(await screen.findByText(/couldn't start \(server error 500\)/)).toBeTruthy();
  });

  test("a stream that ends without a result shows an error", async () => {
    stubFetch(() => ndjson([{ type: "queued", jobId: "job1", position: 1, message: "Queued — next in line" }]));
    renderModal();
    expect(await screen.findByText(/stopped without finishing/)).toBeTruthy();
  });

  test("a job that stops making progress surfaces an error", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });
    stubFetch(() => ndjson([{ type: "pending", jobId: "job1", message: "Still refreshing — this continues in the background." }]));
    renderModal();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(JOB_STALL_MS + 5000);
    });
    expect(screen.getByText(JOB_STALLED_MESSAGE)).toBeTruthy();
  });
});
