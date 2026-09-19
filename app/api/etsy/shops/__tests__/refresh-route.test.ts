import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const { authMock, syncMock } = vi.hoisted(() => ({ authMock: vi.fn(), syncMock: vi.fn() }));
vi.mock("@/auth", () => ({ auth: authMock }));
vi.mock("@/lib/db/prisma", async () => ({ prisma: (await import("@/lib/jobs/__tests__/fake-jobs-prisma")).fakeJobModels }));
vi.mock("@/lib/etsy/auth", () => ({
  getEtsySession: async () => ({ userId: "etsy-1" }),
  sessionCookieOptions: () => ({}),
}));
vi.mock("@/lib/etsy/shop-connections", () => ({
  getActiveShopId: async () => "shop-1",
  getDecryptedRefreshToken: async () => null,
  updateConnectionRefreshToken: async () => {},
  markShopSynced: async () => {},
}));
vi.mock("@/lib/jobs/handlers", async () => {
  const { listingRefreshHandler } = await import("@/lib/jobs/handlers/listing-refresh");
  return {
    jobHandlers: () => ({
      listing_refresh: listingRefreshHandler({
        withShopToken: (_u, _s, fn) => fn(),
        sync: syncMock,
        markSynced: async () => {},
      }),
    }),
  };
});

import { POST } from "@/app/api/etsy/shops/refresh/route";
import { jobsDb, resetJobsDb, seedJob } from "@/lib/jobs/__tests__/fake-jobs-prisma";
import { JOB_STALL_MS, JOB_STALLED_MESSAGE } from "@/lib/jobs/types";

const post = () =>
  POST(new Request("http://localhost/api/etsy/shops/refresh", { method: "POST", body: "{}" }) as never);

const events = (text: string) => text.trim().split("\n").map((l) => JSON.parse(l) as { type: string; message?: string });

beforeEach(() => {
  resetJobsDb();
  authMock.mockResolvedValue({ user: { id: "alice" } });
  syncMock.mockReset();
});

afterEach(() => vi.useRealTimers());

describe("POST /api/etsy/shops/refresh", () => {
  test("runs the refresh job straight away inside the request — no cron or worker pass needed", async () => {
    syncMock.mockImplementation(async (_u, _s, onEvent) => {
      onEvent({ type: "progress", stage: "listings", fetched: 2, total: 2, message: "Fetched 2 of 2" });
      return { inserted: 2, updated: 0, removed: 0, total: 2, resumed: 0 };
    });
    const res = await post();
    const seen = events(await res.text());
    expect(seen.at(-1)).toMatchObject({ type: "done", total: 2 });
    expect(syncMock).toHaveBeenCalledTimes(1);
    expect([...jobsDb.jobs.values()].map((j) => j.status)).toEqual(["done"]);
  });

  test("a job that makes no progress ends the stream with an error instead of spinning", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });
    seedJob({
      userId: "alice",
      type: "listing_refresh",
      priority: 0,
      status: "running",
      activeKey: "refresh:alice:shop-1",
      lockToken: "someone-else",
      lockedUntil: new Date(Date.now() + 60 * 60 * 1000),
    });
    const res = await post();
    const text = res.text();
    await vi.advanceTimersByTimeAsync(JOB_STALL_MS + 5000);
    const seen = events(await text);
    expect(seen.at(-1)).toEqual({ type: "error", message: JOB_STALLED_MESSAGE });
    expect(syncMock).not.toHaveBeenCalled();
  });

  test("a failure before the job exists answers with an error event, not an empty 500", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    authMock.mockRejectedValue(new Error("db down"));
    const res = await post();
    expect(res.status).toBe(500);
    expect(events(await res.text())).toEqual([{ type: "error", message: "db down" }]);
  });
});
