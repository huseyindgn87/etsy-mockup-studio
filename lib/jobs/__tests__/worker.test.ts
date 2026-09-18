import { beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("@/lib/db/prisma", async () => ({ prisma: (await import("./fake-jobs-prisma")).fakeJobModels }));

import { configureEtsyClient, createMemoryRateLimitStore, EtsyLimitError } from "@/lib/etsy/client";
import type { BulkListingDetail } from "@/lib/etsy/listing-details";
import { bulkSaveHandler, BULK_SAVE_CHUNK, type BulkSaveDeps, type BulkSaveJobResult } from "../handlers/bulk-save";
import { enqueueJob, positionOf, toJobView } from "../queue";
import { JOB_PRIORITY } from "../types";
import {
  claimNextJob,
  jobRetryDelayMs,
  LEASE_MS,
  LeaseLostError,
  runJobSlice,
  runWorker,
  type JobHandler,
  type WorkerDeps,
} from "../worker";
import { jobsDb, resetJobsDb, seedJob } from "./fake-jobs-prisma";

const T0 = Date.parse("2026-09-18T12:00:00Z");
let now = T0;
const clock = () => now;
const at = (minute: number) => new Date(T0 - 60 * 60_000 + minute * 60_000);

beforeEach(() => {
  now = T0;
  resetJobsDb(() => new Date(now));
});

/** Records which jobs ran, in order; every job finishes in one slice. */
function recorder() {
  const ran: string[] = [];
  const handler: JobHandler = async (ctx) => {
    ran.push(ctx.job.id);
    return { status: "done" };
  };
  return { ran, handlers: { test: handler } };
}

const deps = (handlers: WorkerDeps["handlers"], extra: Partial<WorkerDeps> = {}): WorkerDeps => ({
  handlers,
  now: clock,
  budgetRetryAt: async () => null,
  ...extra,
});

describe("priority order", () => {
  test("user-initiated work runs first, then scheduled, then background — whatever order it was queued in", async () => {
    seedJob({ id: "bg", userId: "u1", type: "test", priority: JOB_PRIORITY.background, createdAt: at(0) });
    seedJob({ id: "sched", userId: "u2", type: "test", priority: JOB_PRIORITY.scheduled, createdAt: at(1) });
    seedJob({ id: "save", userId: "u3", type: "test", priority: JOB_PRIORITY.interactive, createdAt: at(2) });
    const { ran, handlers } = recorder();
    await runWorker(deps(handlers));
    expect(ran).toEqual(["save", "sched", "bg"]);
    expect([...jobsDb.jobs.values()].every((j) => j.status === "done" && j.activeKey === null)).toBe(true);
  });

  test("a job whose time hasn't come (a retry backoff) waits", async () => {
    seedJob({ id: "later", userId: "u1", type: "test", priority: 0, status: "retrying", runAfter: new Date(T0 + 60_000) });
    const { ran, handlers } = recorder();
    await runWorker(deps(handlers));
    expect(ran).toEqual([]);
    now = T0 + 60_000;
    await runWorker(deps(handlers));
    expect(ran).toEqual(["later"]);
  });
});

describe("fairness between users", () => {
  test("one user's pile of jobs doesn't starve another's: users take turns", async () => {
    for (let i = 0; i < 5; i++) seedJob({ id: `heavy${i}`, userId: "heavy", type: "test", priority: 0, createdAt: at(i) });
    seedJob({ id: "light0", userId: "light", type: "test", priority: 0, createdAt: at(10) });
    seedJob({ id: "light1", userId: "light", type: "test", priority: 0, createdAt: at(11) });
    const { ran, handlers } = recorder();
    await runWorker(deps(handlers, { now: () => (now += 1000) }));
    expect(ran).toEqual(["heavy0", "light0", "heavy1", "light1", "heavy2", "heavy3", "heavy4"]);
  });

  test("a job with 5,000 listings is worked in slices, and another user's job runs between them", async () => {
    const slices: string[] = [];
    const big: JobHandler = async (ctx) => {
      const done = (ctx.progress.done as number | undefined) ?? 0;
      slices.push(`big:${done}`);
      // Each slice does 1,000 listings, then its time is up.
      await ctx.checkpoint({ done: done + 1000, total: 5000 });
      return done + 1000 >= 5000 ? { status: "done" } : { status: "continue" };
    };
    const small: JobHandler = async (ctx) => {
      slices.push(`small:${ctx.job.userId}`);
      return { status: "done" };
    };
    seedJob({ id: "big", userId: "heavy", type: "big", priority: 0, createdAt: at(0) });
    seedJob({ id: "s1", userId: "alice", type: "small", priority: 0, createdAt: at(5) });
    seedJob({ id: "s2", userId: "bob", type: "small", priority: 0, createdAt: at(6) });
    await runWorker(deps({ big, small }, { now: () => (now += 1000) }));
    expect(slices).toEqual(["big:0", "small:alice", "small:bob", "big:1000", "big:2000", "big:3000", "big:4000"]);
    expect(jobsDb.jobs.get("big")!.status).toBe("done");
  });
});

describe("the daily budget is reserved for user-initiated work", () => {
  test("with the budget at 15%: background jobs stay queued, scheduled and user jobs run", async () => {
    configureEtsyClient({
      store: createMemoryRateLimitStore({ perDayLimit: 10_000, remainingToday: 1500, observedAtMs: T0 }),
      now: clock,
    });
    seedJob({ id: "bg", userId: "u1", type: "test", priority: JOB_PRIORITY.background });
    seedJob({ id: "sched", userId: "u2", type: "test", priority: JOB_PRIORITY.scheduled });
    seedJob({ id: "save", userId: "u3", type: "test", priority: JOB_PRIORITY.interactive });
    const { ran, handlers } = recorder();
    const result = await runWorker({ handlers, now: clock });
    expect(ran).toEqual(["save", "sched"]);
    expect(result.heldForBudget).toEqual([JOB_PRIORITY.background]);
    const bg = jobsDb.jobs.get("bg")!;
    expect(bg.status).toBe("queued");
    expect(bg.attempts).toBe(0);
  });

  test("with the budget at 5%, only a job a user is waiting on runs", async () => {
    configureEtsyClient({
      store: createMemoryRateLimitStore({ perDayLimit: 10_000, remainingToday: 500, observedAtMs: T0 }),
      now: clock,
    });
    seedJob({ id: "bg", userId: "u1", type: "test", priority: JOB_PRIORITY.background });
    seedJob({ id: "sched", userId: "u2", type: "test", priority: JOB_PRIORITY.scheduled });
    seedJob({ id: "save", userId: "u3", type: "test", priority: JOB_PRIORITY.interactive });
    const { ran, handlers } = recorder();
    const result = await runWorker({ handlers, now: clock });
    expect(ran).toEqual(["save"]);
    expect(result.heldForBudget).toEqual([JOB_PRIORITY.scheduled, JOB_PRIORITY.background]);
  });

  test("a job that hits Etsy's limit mid-way waits for it without spending an attempt", async () => {
    const retryAt = new Date(T0 + 30 * 60_000);
    seedJob({ id: "j", userId: "u1", type: "limited", priority: 1 });
    await runWorker(deps({ limited: async () => { throw new EtsyLimitError(retryAt); } }));
    const job = jobsDb.jobs.get("j")!;
    expect(job).toMatchObject({ status: "queued", attempts: 0, lockToken: null });
    expect(job.runAfter).toEqual(retryAt);
    expect(job.error).toMatch(/Etsy limit reached/);
  });

  test("background work runs through the client's background tier, user work through the interactive one", async () => {
    const tiers: string[] = [];
    const { currentEtsyContext } = await import("@/lib/etsy/client");
    const handler: JobHandler = async () => {
      tiers.push(currentEtsyContext().priority!);
      return { status: "done" };
    };
    seedJob({ userId: "u1", type: "t", priority: 2 });
    seedJob({ userId: "u2", type: "t", priority: 0 });
    seedJob({ userId: "u3", type: "t", priority: 1 });
    await runWorker(deps({ t: handler }));
    expect(tiers).toEqual(["interactive", "scheduled", "background"]);
  });
});

describe("failures and retries", () => {
  test("a failing job retries with backoff, then fails with its reason", async () => {
    seedJob({ id: "j", userId: "u1", type: "boom", priority: 0 });
    const boom: JobHandler = async () => {
      throw new Error("Etsy said no");
    };
    vi.spyOn(console, "error").mockImplementation(() => {});
    await runWorker(deps({ boom }));
    expect(jobsDb.jobs.get("j")).toMatchObject({ status: "retrying", attempts: 1, error: "Etsy said no" });
    expect(jobsDb.jobs.get("j")!.runAfter.getTime()).toBe(T0 + jobRetryDelayMs(1));

    now += jobRetryDelayMs(1);
    await runWorker(deps({ boom }));
    now += jobRetryDelayMs(2);
    await runWorker(deps({ boom }));
    expect(jobsDb.jobs.get("j")).toMatchObject({ status: "failed", attempts: 3, error: "Etsy said no" });
    expect(jobsDb.jobs.get("j")!.finishedAt).not.toBeNull();
  });

  test("a handler's own 'failed' ends the job at once", async () => {
    seedJob({ id: "j", userId: "u1", type: "bad", priority: 0 });
    await runWorker(deps({ bad: async () => ({ status: "failed", error: "The job has no shop." }) }));
    expect(jobsDb.jobs.get("j")).toMatchObject({ status: "failed", attempts: 0, error: "The job has no shop." });
  });
});

describe("resume after a crash", () => {
  test("a job whose worker died is claimed again once its lease runs out, counted as an attempt", async () => {
    seedJob({ id: "j", userId: "u1", type: "t", priority: 0, status: "running", lockToken: "dead", lockedUntil: new Date(T0 + 1000) });
    expect(await claimNextJob(new Date(T0), [0, 1, 2])).toBeNull();
    const job = await claimNextJob(new Date(T0 + 2000), [0, 1, 2]);
    expect(job).toMatchObject({ id: "j", status: "running", attempts: 1 });
    expect(job!.lockToken).not.toBe("dead");
  });

  test("the dead worker can't write once another has taken over", async () => {
    seedJob({ id: "j", userId: "u1", type: "t", priority: 0 });
    const first = (await claimNextJob(new Date(now), [0]))!;
    now += LEASE_MS + 1;
    const second = (await claimNextJob(new Date(now), [0]))!;
    expect(second.lockToken).not.toBe(first.lockToken);

    let caught: unknown;
    const outcome = await runJobSlice(first, deps({ t: async (ctx) => {
      try {
        await ctx.checkpoint({ step: "late" });
      } catch (err) {
        caught = err;
        throw err;
      }
      return { status: "done" };
    } }), now + 10_000);
    expect(caught).toBeInstanceOf(LeaseLostError);
    expect(outcome).toBe("lost");
    expect(jobsDb.jobs.get("j")).toMatchObject({ status: "running", lockToken: second.lockToken, progress: null });
  });

  test("a bulk save resumed after a crash writes nothing twice", async () => {
    // The worker died after writing 101 and 102: 101's outcome was
    // checkpointed, 102's write landed on Etsy but its checkpoint didn't.
    const updates = [101, 102, 103].map((listingId) => ({ listingId, patch: { title: `New ${listingId}` } }));
    seedJob({
      id: "save",
      userId: "u1",
      type: "bulk_save",
      priority: 0,
      payload: { shopId: "555", updates },
      status: "running",
      lockToken: "dead",
      lockedUntil: new Date(T0 - 1),
      progress: { results: { "101": { listingId: 101, ok: true } }, done: 1, total: 3 },
    });
    const etsy: Record<number, string> = { 101: "New 101", 102: "New 102", 103: "Old 103" };
    const fake = bulkDeps(etsy);

    await runWorker(deps({ bulk_save: bulkSaveHandler(fake.deps) }));

    expect(fake.writes).toEqual([{ listingId: 103, patch: { title: "New 103" } }]);
    const job = jobsDb.jobs.get("save")!;
    expect(job).toMatchObject({ status: "done", attempts: 1 });
    const result = job.result as unknown as BulkSaveJobResult;
    expect(result.results.map((r) => [r.listingId, r.ok, r.unchanged ?? false])).toEqual([
      [101, true, false],
      [102, true, true],
      [103, true, false],
    ]);
  });
});

/** A fake Etsy for bulk saves: current titles by listing, and every write made. */
function bulkDeps(titles: Record<number, string>) {
  const reads: number[][] = [];
  const writes: { listingId: number; patch: object }[] = [];
  const deps: BulkSaveDeps = {
    withShopToken: async (_u, _s, fn) => fn(),
    readListings: async (ids) => {
      reads.push(ids);
      return ids.filter((id) => titles[id] !== undefined).map((id) => detail(id, titles[id]));
    },
    apply: async (_shop, update) => {
      writes.push(update);
      if (update.patch.title) titles[update.listingId] = update.patch.title;
      return { listingId: update.listingId, ok: true };
    },
    mirror: async () => {},
  };
  return { deps, reads, writes };
}

function detail(listingId: number, title: string): BulkListingDetail {
  return {
    listingId,
    title,
    description: "",
    tags: [],
    materials: [],
    state: "active",
    url: "",
    thumbnailUrl: null,
    shopSectionId: null,
    shippingProfileId: null,
    returnPolicyId: null,
    readinessStateId: null,
    taxonomyId: null,
    whoMade: "i_did",
    whenMade: "made_to_order",
    isSupply: false,
    productionPartnerIds: [],
    itemWeight: null,
    itemWeightUnit: null,
    itemLength: null,
    itemWidth: null,
    itemHeight: null,
    itemDimensionsUnit: null,
    shouldAutoRenew: false,
    isTaxable: true,
    featured: false,
    shopId: 555,
    price: 10,
    quantity: 4,
    sku: "SKU",
    images: [],
    videos: [],
    personalizationQuestions: [],
    hasVariations: false,
  };
}

describe("batching and skipping unchanged listings", () => {
  test(`reads listings ${BULK_SAVE_CHUNK} per call and writes only the ones that differ`, async () => {
    const titles: Record<number, string> = {};
    const updates = Array.from({ length: 25 }, (_, i) => {
      const id = 1000 + i;
      titles[id] = i % 5 === 0 ? `Title ${id}` : `Old ${id}`;
      return { listingId: id, patch: { title: `Title ${id}` } };
    });
    seedJob({ id: "save", userId: "u1", type: "bulk_save", priority: 0, payload: { shopId: "555", updates } });
    const fake = bulkDeps(titles);
    await runWorker(deps({ bulk_save: bulkSaveHandler(fake.deps) }));

    expect(fake.reads.map((ids) => ids.length)).toEqual([10, 10, 5]);
    expect(fake.writes).toHaveLength(20);
    const result = jobsDb.jobs.get("save")!.result as unknown as BulkSaveJobResult;
    expect(result.saved).toBe(25);
    expect(result.results.filter((r) => r.unchanged)).toHaveLength(5);
  });

  test("a big save hands the worker back between chunks and resumes where it left off", async () => {
    const titles: Record<number, string> = {};
    const updates = Array.from({ length: 30 }, (_, i) => ({ listingId: 2000 + i, patch: { title: `T${i}` } }));
    for (const u of updates) titles[u.listingId] = "old";
    seedJob({ id: "save", userId: "u1", type: "bulk_save", priority: 0, payload: { shopId: "555", updates } });
    const fake = bulkDeps(titles);
    // Every read takes 25 s of the 20 s slice.
    const slow = { ...fake.deps, readListings: async (ids: number[]) => ((now += 25_000), fake.deps.readListings(ids)) };
    await runWorker(deps({ bulk_save: bulkSaveHandler(slow) }, { sliceMs: 20_000 }), { maxSlices: 1 });
    expect(jobsDb.jobs.get("save")).toMatchObject({ status: "queued" });
    expect(fake.writes).toHaveLength(10);

    await runWorker(deps({ bulk_save: bulkSaveHandler(slow) }, { sliceMs: 20_000 }));
    expect(fake.writes.map((w) => w.listingId)).toEqual(updates.map((u) => u.listingId));
    expect(jobsDb.jobs.get("save")).toMatchObject({ status: "done", attempts: 0 });
  });
});

describe("enqueueing and the status a user sees", () => {
  test("an active key keeps one unfinished job: a second Refresh follows the first", async () => {
    const a = await enqueueJob({ userId: "u1", type: "listing_refresh", payload: {}, priority: 0, activeKey: "refresh:u1:1" });
    const b = await enqueueJob({ userId: "u1", type: "listing_refresh", payload: {}, priority: 0, activeKey: "refresh:u1:1" });
    expect(b.id).toBe(a.id);
    await runWorker(deps({ listing_refresh: async () => ({ status: "done" }) }));
    const c = await enqueueJob({ userId: "u1", type: "listing_refresh", payload: {}, priority: 0, activeKey: "refresh:u1:1" });
    expect(c.id).not.toBe(a.id);
  });

  test("queued shows its place in line; running shows progress; failed shows why", async () => {
    seedJob({ id: "ahead", userId: "u2", type: "t", priority: 0, createdAt: at(0) });
    const mine = seedJob({ id: "mine", userId: "u1", type: "t", priority: 0, createdAt: at(1) });
    expect(await positionOf(mine)).toBe(2);
    expect((await toJobView(mine)).position).toBe(2);

    const running = seedJob({ id: "run", userId: "u3", type: "t", priority: 2, status: "running", progress: { done: 5, total: 40 } });
    expect(await toJobView(running)).toMatchObject({ status: "running", position: null, progress: { done: 5, total: 40 } });

    const failed = seedJob({ id: "f", userId: "u1", type: "t", priority: 0, status: "failed", error: "Listing not found." });
    expect(await toJobView(failed)).toMatchObject({ status: "failed", error: "Listing not found." });
  });
});
