import { afterEach, describe, expect, test, vi } from "vitest";
import { syncListingPatch } from "@/lib/etsy/sync-request";
import type { JobView } from "../types";

const job = (over: Partial<JobView>): JobView => ({
  id: "job1",
  type: "bulk_save",
  status: "queued",
  priority: 0,
  position: 2,
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

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("a save that's still queued when the request answers", () => {
  test("is followed until done, reporting each status on the way", async () => {
    const polls = [
      job({ status: "running", position: null, progress: { done: 0, total: 1, message: null } }),
      job({ status: "done", position: null, result: { results: [{ listingId: 7, ok: true }] } }),
    ];
    const fetchMock = vi.fn(async (url: string) => {
      if (url === "/api/etsy/listings/bulk/save") return json({ jobId: "job1", job: job({}) }, 202);
      if (url === "/api/jobs/job1?help=1") return json({ job: polls.shift() });
      throw new Error(`unexpected ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.useFakeTimers({ shouldAdvanceTime: true, advanceTimeDelta: 500 });

    const seen: string[] = [];
    const result = await syncListingPatch(7, { title: "New" }, (j) => seen.push(j.status));

    expect(result).toEqual({ listingId: 7, ok: true });
    expect(seen).toEqual(["queued", "running", "done"]);
  });

  test("a job that fails reports its reason on the row", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url.startsWith("/api/jobs/")
          ? json({ job: job({ status: "failed", position: null, error: "This Etsy shop is no longer connected." }) })
          : json({ jobId: "job1", job: job({}) }, 202),
      ),
    );
    const result = await syncListingPatch(7, { title: "New" });
    expect(result).toEqual({ listingId: 7, ok: false, error: "This Etsy shop is no longer connected." });
  });

  test("a save that finished inside the request answers straight away", async () => {
    const fetchMock = vi.fn(async () => json({ jobId: "job1", results: [{ listingId: 7, ok: true }], saved: 1, partial: 0, failed: 0 }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await syncListingPatch(7, { title: "New" })).toEqual({ listingId: 7, ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
