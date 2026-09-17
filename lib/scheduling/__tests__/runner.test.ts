import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("@/lib/db/prisma", async () => ({ prisma: (await import("./fake-prisma")).fakePrisma }));

import type { ScheduledListing } from "@prisma/client";
import { renderImageKey } from "../render-keys";
import {
  BASE_RETRY_DELAY_MS,
  claimScheduledListing,
  cleanupPublishedImages,
  retryDelayMs,
  runDueScheduledListings,
  STALE_PUBLISHING_MS,
  type RunnerDeps,
} from "../runner";
import { MAX_PUBLISH_ATTEMPTS } from "../types";
import { db, resetDb, seedScheduled } from "./fake-prisma";
import { SET_A, SET_B, storedImages } from "./fixtures";

const NOW = new Date("2026-09-17T12:00:00Z");
const MINUTE = 60_000;

let nextDraft = 1;

/** A pending row whose time has just passed. */
function dueRow(overrides: Partial<Parameters<typeof seedScheduled>[0]> = {}) {
  const draftId = `draft-${nextDraft++}`;
  return seedScheduled({
    userId: "alice",
    shopId: "111",
    draftId,
    activeDraftId: draftId,
    scheduledAt: new Date(NOW.getTime() - MINUTE),
    renderSetId: SET_A,
    images: storedImages("alice", 3),
    publishSpec: {},
    ...overrides,
  });
}

function makeDeps(publish?: RunnerDeps["publish"]) {
  let created = 0;
  return {
    publish: vi.fn<RunnerDeps["publish"]>(
      publish ??
        (async (row, hooks) => {
          if (row.etsyListingId) return row.etsyListingId;
          const id = String(9000 + ++created);
          await hooks.onListingCreated(id);
          return id;
        }),
    ),
    applyBulkEdit: vi.fn<RunnerDeps["applyBulkEdit"]>(async (_row, updates) =>
      updates.map((u) => ({ listingId: u.listingId, title: u.title, ok: true })),
    ),
    deleteImages: vi.fn<RunnerDeps["deleteImages"]>(async () => {}),
    now: () => new Date(),
  };
}

const failing = (message = "Etsy said no") => makeDeps(async () => {
  throw new Error(message);
});

const at = (ms: number) => vi.setSystemTime(new Date(NOW.getTime() + ms));
const row = (id: string) => db.scheduled.get(id)!;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  resetDb();
  nextDraft = 1;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("claiming is atomic", () => {
  test("of ten concurrent claims on one row, exactly one wins", async () => {
    const r = dueRow();
    const results = await Promise.all(Array.from({ length: 10 }, () => claimScheduledListing(r.id, new Date())));
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(row(r.id).status).toBe("publishing");
  });

  test("two runs racing over the same due rows publish each row exactly once", async () => {
    const ids = Array.from({ length: 5 }, () => dueRow().id);
    // A slow publish, so the two runs genuinely interleave.
    const slow: RunnerDeps["publish"] = async (r, hooks) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      await hooks.onListingCreated(`etsy-${r.id}`);
      return `etsy-${r.id}`;
    };
    const a = makeDeps(slow);
    const b = makeDeps(slow);

    const [ra, rb] = await Promise.all([runDueScheduledListings(a), runDueScheduledListings(b)]);

    const publishedIds = [...a.publish.mock.calls, ...b.publish.mock.calls].map(([r]) => r.id);
    expect(publishedIds.sort()).toEqual([...ids].sort());
    expect([...ra.published, ...rb.published].sort()).toEqual([...ids].sort());
    expect(ra.skipped + rb.skipped).toBe(5);
    for (const id of ids) expect(row(id)).toMatchObject({ status: "published", etsyListingId: `etsy-${id}` });
  });

  test("a row that stopped being pending (e.g. cancelled) can't be claimed", async () => {
    const r = dueRow({ status: "cancelled" });
    expect(await claimScheduledListing(r.id, new Date())).toBe(false);
    expect(row(r.id).status).toBe("cancelled");
  });

  test("rows that aren't due — a future time, or a retry still backing off — are left alone", async () => {
    const future = dueRow({ scheduledAt: new Date(NOW.getTime() + MINUTE) });
    const backingOff = dueRow({ attemptCount: 1, nextAttemptAt: new Date(NOW.getTime() + MINUTE) });
    const deps = makeDeps();
    await runDueScheduledListings(deps);
    expect(deps.publish).not.toHaveBeenCalled();
    expect(row(future.id).status).toBe("pending");
    expect(row(backingOff.id).status).toBe("pending");
  });
});

describe("a successful publish", () => {
  test("records the Etsy listing id, marks the row published, releases the draft, then deletes its images", async () => {
    const r = dueRow();
    const deps = makeDeps();
    const result = await runDueScheduledListings(deps);

    expect(result.published).toEqual([r.id]);
    expect(row(r.id)).toMatchObject({
      status: "published",
      etsyListingId: "9001",
      activeDraftId: null,
      lastError: null,
      nextAttemptAt: null,
    });
    expect(deps.deleteImages).toHaveBeenCalledTimes(1);
    expect(deps.deleteImages).toHaveBeenCalledWith(storedImages("alice", 3).map((i) => i.key));
  });

  test("published rows are never processed again", async () => {
    const r = dueRow();
    const deps = makeDeps();
    await runDueScheduledListings(deps);
    at(60 * MINUTE);
    await runDueScheduledListings(deps);
    expect(deps.publish).toHaveBeenCalledTimes(1);

    const alreadyPublished = dueRow({ status: "published", etsyListingId: "555", activeDraftId: null });
    const again = makeDeps();
    await runDueScheduledListings(again);
    expect(again.publish).not.toHaveBeenCalled();
    expect(again.deleteImages).not.toHaveBeenCalled();
    expect(row(alreadyPublished.id)).toMatchObject({ status: "published", etsyListingId: "555" });
    expect(row(r.id).status).toBe("published");
  });

  test("cancelled and failed rows are never published", async () => {
    dueRow({ status: "cancelled", activeDraftId: null });
    dueRow({ status: "failed", attemptCount: MAX_PUBLISH_ATTEMPTS });
    const deps = makeDeps();
    await runDueScheduledListings(deps);
    expect(deps.publish).not.toHaveBeenCalled();
  });

  test("a listing with 20 images is published and all 20 are cleaned up", async () => {
    const r = dueRow({ images: storedImages("alice", 20) });
    const deps = makeDeps();
    await runDueScheduledListings(deps);
    expect(deps.publish.mock.calls[0][0].images).toHaveLength(20);
    expect(row(r.id).status).toBe("published");
    const deleted = deps.deleteImages.mock.calls[0][0];
    expect(deleted).toHaveLength(20);
    expect(deleted[0]).toBe(renderImageKey("alice", SET_A, 0));
    expect(deleted[19]).toBe(renderImageKey("alice", SET_A, 19));
  });

  test("a storage failure during cleanup leaves the listing published", async () => {
    const r = dueRow();
    const deps = makeDeps();
    deps.deleteImages.mockRejectedValueOnce(new Error("R2 is down"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await runDueScheduledListings(deps);
    expect(result.published).toEqual([r.id]);
    expect(row(r.id).status).toBe("published");
  });
});

describe("failures, retries and backoff", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  test("backoff grows: 5 minutes after the first failure, 20 after the second", () => {
    expect(BASE_RETRY_DELAY_MS).toBe(5 * MINUTE);
    expect(retryDelayMs(1)).toBe(5 * MINUTE);
    expect(retryDelayMs(2)).toBe(20 * MINUTE);
  });

  test("a failure records the error, counts the attempt and schedules a retry — images are kept", async () => {
    const r = dueRow();
    const deps = failing("Etsy 503: try later");
    const result = await runDueScheduledListings(deps);

    expect(result.retrying).toEqual([r.id]);
    expect(row(r.id)).toMatchObject({
      status: "pending",
      attemptCount: 1,
      lastError: "Etsy 503: try later",
      activeDraftId: r.draftId,
    });
    expect(row(r.id).nextAttemptAt).toEqual(new Date(NOW.getTime() + 5 * MINUTE));
    expect(deps.deleteImages).not.toHaveBeenCalled();
  });

  test("a retry waits out its backoff before it's attempted again", async () => {
    const r = dueRow();
    const deps = failing();
    await runDueScheduledListings(deps);

    at(4 * MINUTE);
    await runDueScheduledListings(deps);
    expect(deps.publish).toHaveBeenCalledTimes(1);

    at(5 * MINUTE);
    await runDueScheduledListings(deps);
    expect(deps.publish).toHaveBeenCalledTimes(2);
    expect(row(r.id)).toMatchObject({ status: "pending", attemptCount: 2 });
    expect(row(r.id).nextAttemptAt).toEqual(new Date(NOW.getTime() + 25 * MINUTE));
  });

  test(`after ${MAX_PUBLISH_ATTEMPTS} failed attempts the row is failed for good, with its images kept`, async () => {
    const r = dueRow();
    const deps = failing("Shipping profile incomplete");
    await runDueScheduledListings(deps); // attempt 1
    at(5 * MINUTE);
    await runDueScheduledListings(deps); // attempt 2
    at(25 * MINUTE);
    const result = await runDueScheduledListings(deps); // attempt 3

    expect(result.failed).toEqual([r.id]);
    expect(row(r.id)).toMatchObject({
      status: "failed",
      attemptCount: 3,
      lastError: "Shipping profile incomplete",
      nextAttemptAt: null,
      images: storedImages("alice", 3),
      // Still the draft's active schedule — the user retries by rescheduling it.
      activeDraftId: r.draftId,
    });

    at(24 * 60 * MINUTE);
    await runDueScheduledListings(deps);
    expect(deps.publish).toHaveBeenCalledTimes(3);
    expect(deps.deleteImages).not.toHaveBeenCalled();
  });

  test("a retry that succeeds publishes normally and only then deletes the images", async () => {
    const r = dueRow();
    let calls = 0;
    const deps = makeDeps(async () => {
      if (++calls === 1) throw new Error("timeout");
      return "4242";
    });
    await runDueScheduledListings(deps);
    expect(deps.deleteImages).not.toHaveBeenCalled();
    at(5 * MINUTE);
    await runDueScheduledListings(deps);
    expect(row(r.id)).toMatchObject({ status: "published", etsyListingId: "4242" });
    expect(deps.deleteImages).toHaveBeenCalledTimes(1);
  });

  test("a listing Etsy created before the failure is recorded and reused by the retry — never created twice", async () => {
    const r = dueRow();
    const seen: (string | null)[] = [];
    const deps = makeDeps(async (claimed, hooks) => {
      seen.push(claimed.etsyListingId);
      if (!claimed.etsyListingId) {
        await hooks.onListingCreated("777");
        throw new Error("image upload failed");
      }
      return claimed.etsyListingId;
    });
    await runDueScheduledListings(deps);
    expect(row(r.id)).toMatchObject({ status: "pending", etsyListingId: "777" });

    at(5 * MINUTE);
    await runDueScheduledListings(deps);
    expect(seen).toEqual([null, "777"]);
    expect(row(r.id)).toMatchObject({ status: "published", etsyListingId: "777" });
  });

  test("a row abandoned mid-publish (crashed run) goes back into the retry cycle; a live one is left alone", async () => {
    const stale = dueRow({
      status: "publishing",
      etsyListingId: "888",
      updatedAt: new Date(NOW.getTime() - STALE_PUBLISHING_MS - MINUTE),
    });
    const live = dueRow({ status: "publishing", updatedAt: new Date(NOW.getTime() - MINUTE) });
    const deps = makeDeps();
    const result = await runDueScheduledListings(deps);

    expect(result.recovered).toBe(1);
    expect(row(stale.id)).toMatchObject({
      status: "pending",
      attemptCount: 1,
      etsyListingId: "888",
      lastError: "Publishing was interrupted before it finished.",
    });
    expect(row(live.id).status).toBe("publishing");
    expect(deps.publish).not.toHaveBeenCalled();
  });
});

describe("storage cleanup never touches user uploads", () => {
  const userUploads = [
    "drafts/draft-1/own/photo-1",
    "drafts/draft-1/design/d1",
    "drafts/draft-1/psd/m1",
    "templates/user/alice/my-mockup.png",
  ];
  const notThisJob = [
    renderImageKey("bob", SET_A, 0), // another user's render
    renderImageKey("alice", SET_B, 0), // another schedule's render set
    `scheduled/alice/${SET_A}/../../drafts/draft-1/own/photo-1`,
    `scheduled/alice/${SET_A}/image-20`,
    `scheduled/alice/${SET_A}/`,
  ];

  function rowWithKeys(keys: string[]) {
    return {
      id: "s1",
      userId: "alice",
      renderSetId: SET_A,
      images: keys.map((key) => ({ key, filename: "x.jpg", contentType: "image/jpeg" })),
    } as Pick<ScheduledListing, "id" | "userId" | "renderSetId" | "images">;
  }

  test("only keys under the row's own scheduled/{user}/{renderSet}/ prefix are deleted", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const own = storedImages("alice", 2).map((i) => i.key);
    const deleteImages = vi.fn(async () => {});
    const deleted = await cleanupPublishedImages(rowWithKeys([...userUploads, ...own, ...notThisJob]), deleteImages);
    expect(deleted).toBe(2);
    expect(deleteImages).toHaveBeenCalledWith(own);
  });

  test("a row whose images are all user uploads deletes nothing at all", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const deleteImages = vi.fn(async () => {});
    await cleanupPublishedImages(rowWithKeys(userUploads), deleteImages);
    await cleanupPublishedImages({ ...rowWithKeys(storedImages("alice", 2).map((i) => i.key)), renderSetId: null }, deleteImages);
    expect(deleteImages).not.toHaveBeenCalled();
  });

  test("end to end: publishing a row that somehow references user uploads still only deletes its own renders", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const own = storedImages("alice", 2);
    dueRow({
      images: [...own, ...userUploads.map((key) => ({ key, filename: "x.jpg", contentType: "image/jpeg" }))],
    });
    const deps = makeDeps();
    await runDueScheduledListings(deps);
    const deleted = deps.deleteImages.mock.calls.flatMap(([keys]) => keys);
    expect(deleted).toEqual(own.map((i) => i.key));
    for (const key of userUploads) expect(deleted).not.toContain(key);
  });
});
