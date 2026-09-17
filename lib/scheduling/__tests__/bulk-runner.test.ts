import { beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("@/lib/db/prisma", async () => ({ prisma: (await import("./fake-prisma")).fakePrisma }));

import type { ScheduledBulkEdit } from "../bulk-job";
import { bulkMediaKey } from "../render-keys";
import { runDueScheduledListings, type RunnerDeps } from "../runner";
import { MAX_PUBLISH_ATTEMPTS, type ScheduledBulkResult } from "../types";
import { db, resetDb, seedScheduled, type FakeScheduledListing } from "./fake-prisma";
import { SET_A } from "./fixtures";

const NOW = new Date("2026-09-17T12:00:00Z");
const MINUTE = 60_000;

const JOB: ScheduledBulkEdit = {
  updates: [
    { listingId: 101, title: "Mug", patch: { title: "New mug title" } },
    { listingId: 102, title: "Tee", patch: { quantity: 4 } },
  ],
};

/** A bulk edit whose time has just passed. */
function dueBulk(overrides: Partial<FakeScheduledListing> = {}) {
  return seedScheduled({
    userId: "alice",
    shopId: "111",
    kind: "bulk_edit",
    scheduledAt: new Date(NOW.getTime() - MINUTE),
    bulkEdit: JOB,
    ...overrides,
  });
}

function deps(
  applyBulkEdit?: RunnerDeps["applyBulkEdit"],
): RunnerDeps & { applyBulkEdit: ReturnType<typeof vi.fn> } {
  return {
    publish: vi.fn(async () => "9001"),
    applyBulkEdit: vi.fn<RunnerDeps["applyBulkEdit"]>(
      applyBulkEdit ?? (async (_row, updates) => updates.map((u) => ({ listingId: u.listingId, title: u.title, ok: true }))),
    ),
    deleteImages: vi.fn(async () => {}),
    now: () => NOW,
  } as never;
}

const row = (id: string) => db.scheduled.get(id)!;
const results = (id: string) => row(id).results as ScheduledBulkResult[];

beforeEach(() => {
  resetDb();
});

describe("a due bulk edit", () => {
  test("is applied and records every listing it covered", async () => {
    const job = dueBulk();
    const d = deps();

    const result = await runDueScheduledListings(d);

    expect(result.published).toEqual([job.id]);
    expect(d.applyBulkEdit).toHaveBeenCalledTimes(1);
    expect(d.applyBulkEdit.mock.calls[0][1]).toEqual(JOB.updates);
    expect(d.publish).not.toHaveBeenCalled();
    expect(row(job.id).status).toBe("published");
    expect(results(job.id)).toEqual([
      { listingId: 101, title: "Mug", ok: true },
      { listingId: 102, title: "Tee", ok: true },
    ]);
  });

  test("isn't touched before its time", async () => {
    const job = dueBulk({ scheduledAt: new Date(NOW.getTime() + MINUTE) });
    const d = deps();

    expect(await runDueScheduledListings(d)).toMatchObject({ published: [], failed: [] });
    expect(d.applyBulkEdit).not.toHaveBeenCalled();
    expect(row(job.id).status).toBe("pending");
  });

  test("its stored photos are deleted once it has run", async () => {
    const key = bulkMediaKey("alice", SET_A, 101, "image", 0);
    const job = dueBulk({
      renderSetId: SET_A,
      bulkEdit: {
        updates: [
          {
            ...JOB.updates[0],
            media: {
              images: [{ kind: "new", index: 0, altText: "" }],
              videos: [],
              imageFiles: [{ key, filename: "a.jpg", contentType: "image/jpeg" }],
              videoFiles: [],
            },
          },
        ],
      },
    });
    const d = deps();

    await runDueScheduledListings(d);

    expect(row(job.id).status).toBe("published");
    expect(d.deleteImages).toHaveBeenCalledWith([key]);
  });
});

describe("a listing that fails", () => {
  const oneFails: RunnerDeps["applyBulkEdit"] = async (_row, updates) =>
    updates.map((u) => ({
      listingId: u.listingId,
      title: u.title,
      ok: u.listingId !== 102,
      ...(u.listingId === 102 ? { error: "Etsy rejected the quantity." } : {}),
    }));

  test("doesn't stop the rest, and is recorded against its own listing", async () => {
    const job = dueBulk();

    const result = await runDueScheduledListings(deps(oneFails));

    expect(result).toMatchObject({ published: [], retrying: [job.id] });
    expect(results(job.id)).toEqual([
      { listingId: 101, title: "Mug", ok: true },
      { listingId: 102, title: "Tee", ok: false, error: "Etsy rejected the quantity." },
    ]);
    expect(row(job.id).lastError).toBe("Updated 1 of 2 listings. 1 failed. Tee: Etsy rejected the quantity.");
    expect(row(job.id).status).toBe("pending");
  });

  test("the retry writes only that listing, and the job finishes when it lands", async () => {
    const job = dueBulk();
    await runDueScheduledListings(deps(oneFails));

    const retry = deps();
    db.scheduled.set(job.id, { ...row(job.id), nextAttemptAt: null });
    await runDueScheduledListings(retry);

    expect(retry.applyBulkEdit.mock.calls[0][1]).toEqual([JOB.updates[1]]);
    expect(row(job.id).status).toBe("published");
    expect(results(job.id)).toEqual([
      { listingId: 101, title: "Mug", ok: true },
      { listingId: 102, title: "Tee", ok: true },
    ]);
  });

  test("after the last attempt the job is failed, keeping what each listing did", async () => {
    const job = dueBulk({ attemptCount: MAX_PUBLISH_ATTEMPTS - 1 });

    const result = await runDueScheduledListings(deps(oneFails));

    expect(result.failed).toEqual([job.id]);
    expect(row(job.id).status).toBe("failed");
    expect(results(job.id).map((r) => r.ok)).toEqual([true, false]);
  });

  test("an applier that throws outright fails the attempt without losing the job", async () => {
    const job = dueBulk();

    const result = await runDueScheduledListings(
      deps(async () => {
        throw new Error("Etsy is unreachable.");
      }),
    );

    expect(result.retrying).toEqual([job.id]);
    expect(row(job.id).lastError).toBe("Etsy is unreachable.");
    expect(row(job.id).bulkEdit).toEqual(JOB);
  });

  test("stored edits that no longer parse fail with a message rather than being half applied", async () => {
    const job = dueBulk({ bulkEdit: { updates: [{ listingId: 0, title: "", patch: { title: "x" } }] } });
    const d = deps();

    await runDueScheduledListings(d);

    expect(d.applyBulkEdit).not.toHaveBeenCalled();
    expect(row(job.id).lastError).toContain("The scheduled edits are invalid");
  });
});
