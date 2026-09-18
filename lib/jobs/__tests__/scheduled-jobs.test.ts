import { beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("@/lib/db/prisma", async () => {
  const scheduling = (await import("@/lib/scheduling/__tests__/fake-prisma")).fakePrisma;
  const jobs = (await import("./fake-jobs-prisma")).fakeJobModels;
  return { prisma: { ...scheduling, ...jobs } };
});

import { db, resetDb, seedScheduled } from "@/lib/scheduling/__tests__/fake-prisma";
import type { RunnerDeps } from "@/lib/scheduling/runner";
import type { ScheduledBulkResult } from "@/lib/scheduling/types";
import { scheduledListingHandler } from "../handlers/scheduled-listing";
import { enqueueDueScheduledListings } from "../run";
import { JOB_PRIORITY } from "../types";
import { runWorker } from "../worker";
import { jobsDb, resetJobsDb, seedJob } from "./fake-jobs-prisma";

let now = Date.parse("2026-09-18T12:00:00Z");
const MINUTE = 60_000;

beforeEach(() => {
  now = Date.parse("2026-09-18T12:00:00Z");
  resetDb();
  resetJobsDb(() => new Date(now));
});

function runnerDeps() {
  let created = 0;
  const applied: number[] = [];
  const deps: RunnerDeps = {
    publish: vi.fn<RunnerDeps["publish"]>(async (row, hooks) => {
      if (row.etsyListingId) return row.etsyListingId;
      const id = String(9000 + ++created);
      await hooks.onListingCreated(id);
      return id;
    }),
    applyBulkEdit: vi.fn<RunnerDeps["applyBulkEdit"]>(async (_row, updates) => {
      now += 25_000; // each chunk takes longer than a slice
      applied.push(...updates.map((u) => u.listingId));
      return updates.map((u) => ({ listingId: u.listingId, title: u.title, ok: true }));
    }),
    deleteImages: vi.fn(async () => {}),
    now: () => new Date(now),
  };
  return { deps, applied, created: () => created };
}

const workerDeps = (deps: RunnerDeps) => ({
  handlers: { scheduled_listing: scheduledListingHandler(deps) },
  now: () => now,
  budgetRetryAt: async () => null,
});

describe("scheduled listings go through the queue", () => {
  test("a due row is queued once, at scheduled priority, and published by the worker", async () => {
    const row = seedScheduled({ userId: "alice", shopId: "111", scheduledAt: new Date(now - MINUTE), publishSpec: {} });
    expect(await enqueueDueScheduledListings(new Date(now))).toBe(1);
    await enqueueDueScheduledListings(new Date(now));
    const jobs = [...jobsDb.jobs.values()];
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ type: "scheduled_listing", priority: JOB_PRIORITY.scheduled, userId: "alice" });

    const { deps } = runnerDeps();
    await runWorker(workerDeps(deps));
    expect(db.scheduled.get(row.id)).toMatchObject({ status: "published", etsyListingId: "9001" });
    expect(jobs[0].status).toBe("done");
  });

  test("a worker that died mid-publish is resumed without creating a second Etsy listing", async () => {
    // The dead worker had claimed the row and Etsy had created listing 777.
    const row = seedScheduled({
      userId: "alice",
      shopId: "111",
      scheduledAt: new Date(now - MINUTE),
      status: "publishing",
      etsyListingId: "777",
      publishSpec: {},
    });
    seedJob({
      userId: "alice",
      type: "scheduled_listing",
      priority: JOB_PRIORITY.scheduled,
      payload: { scheduledListingId: row.id },
      status: "running",
      lockToken: "dead",
      lockedUntil: new Date(now - 1),
      progress: { claimed: true },
    });
    const fake = runnerDeps();
    await runWorker(workerDeps(fake.deps));
    expect(fake.created()).toBe(0);
    expect(db.scheduled.get(row.id)).toMatchObject({ status: "published", etsyListingId: "777" });
  });

  test("a big scheduled bulk edit is worked in chunks across slices and writes each listing once", async () => {
    const updates = Array.from({ length: 25 }, (_, i) => ({ listingId: 100 + i, title: `L${i}`, patch: { title: `T${i}` } }));
    const row = seedScheduled({
      userId: "alice",
      shopId: "111",
      kind: "bulk_edit",
      scheduledAt: new Date(now - MINUTE),
      bulkEdit: { updates },
    });
    await enqueueDueScheduledListings(new Date(now));
    const fake = runnerDeps();

    await runWorker(workerDeps(fake.deps), { maxSlices: 1 });
    expect(fake.applied).toHaveLength(10);
    expect(db.scheduled.get(row.id)!.status).toBe("publishing");
    expect((db.scheduled.get(row.id)!.results as ScheduledBulkResult[]).length).toBe(10);
    expect([...jobsDb.jobs.values()][0].status).toBe("queued");

    await runWorker(workerDeps(fake.deps));
    expect(fake.applied).toEqual(updates.map((u) => u.listingId));
    expect(db.scheduled.get(row.id)!.status).toBe("published");
  });
});
