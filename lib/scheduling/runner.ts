/**
 * The scheduled-listing runner: publishes every pending `ScheduledListing`
 * whose time has come. Triggered by `POST /api/schedule/run` (a cron service,
 * or `npm run schedule:run`). Server-only.
 *
 * For each due row:
 *   1. Claim it — a conditional update from "pending" to "publishing". Only
 *      one caller's update can match, so two concurrent runs never publish
 *      the same row; the loser just skips it.
 *   2. Publish it (lib/scheduling/publisher.ts): create the Etsy listing,
 *      attach the stored images in order, activate it. Nothing is rendered.
 *   3. Success → record the Etsy listing id, mark "published", then delete
 *      the row's own images from R2 (Etsy has its copy). Failure → record the
 *      error and count the attempt; retry after a backoff, and after
 *      {@link MAX_PUBLISH_ATTEMPTS} mark "failed", keeping the images so the
 *      user can reschedule.
 *
 * Only "pending" rows are ever claimed, so a published (or cancelled, or
 * failed) row is never processed again.
 */

import { Prisma, type ScheduledListing } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import {
  bulkEditFileKeys,
  coerceBulkResults,
  parseScheduledBulkEdit,
  pendingBulkUpdates,
  summariseBulkResults,
  type ScheduledBulkUpdate,
} from "./bulk-job";
import { coerceScheduledImages } from "./publish-spec";
import { isOwnedRenderKey, isOwnedScheduleKey } from "./render-keys";
import { MAX_PUBLISH_ATTEMPTS, type ScheduledBulkResult } from "./types";

/** Delay before retry `n` (after the n-th failed attempt): 5 minutes, then 20. */
export const BASE_RETRY_DELAY_MS = 5 * 60 * 1000;
/** A row left "publishing" this long was interrupted (a crashed run) — it's counted as a failed attempt. */
export const STALE_PUBLISHING_MS = 30 * 60 * 1000;
/** Rows published per run; the rest wait for the next run. */
export const RUN_BATCH_LIMIT = 10;

export function retryDelayMs(failedAttempts: number): number {
  return BASE_RETRY_DELAY_MS * 4 ** Math.max(0, failedAttempts - 1);
}

export interface PublishHooks {
  /** Called as soon as Etsy creates the listing, so a retry reuses it instead of creating a duplicate. */
  onListingCreated: (etsyListingId: string) => Promise<void>;
}

export interface RunnerDeps {
  /** Publishes a claimed row to Etsy; resolves to the Etsy listing id. */
  publish: (row: ScheduledListing, hooks: PublishHooks) => Promise<string>;
  /**
   * Applies a claimed bulk edit's listings, one result per listing. It never
   * throws for a single listing: a listing that fails is reported in its own
   * result and the rest are still written.
   */
  applyBulkEdit: (row: ScheduledListing, updates: ScheduledBulkUpdate[]) => Promise<ScheduledBulkResult[]>;
  /** Deletes exactly these R2 keys. */
  deleteImages: (keys: string[]) => Promise<void>;
  /** Deletes the draft a scheduled publish came from, once it is on Etsy. */
  deleteDraft?: (userId: string, draftId: string) => Promise<unknown>;
  now: () => Date;
}

export interface RunResult {
  published: string[];
  retrying: string[];
  failed: string[];
  /** Due rows another run claimed first. */
  skipped: number;
  /** "publishing" rows found abandoned and returned to the retry cycle. */
  recovered: number;
}

/** Due now: pending, time reached, and not holding for a retry backoff. */
function dueWhere(now: Date) {
  return {
    status: "pending",
    scheduledAt: { lte: now },
    OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }],
  };
}

/**
 * Atomically moves one row from "pending" to "publishing", re-checking it's
 * still due. `true` only for the single caller whose update matched.
 */
export async function claimScheduledListing(id: string, now: Date): Promise<boolean> {
  const { count } = await prisma.scheduledListing.updateMany({
    where: { id, ...dueWhere(now) },
    data: { status: "publishing" },
  });
  return count === 1;
}

function errorMessage(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return (message || "Unknown error").slice(0, 1000);
}

/** Records a failed attempt on a row still in "publishing": back to "pending" with a backoff, or "failed" after the last attempt. */
async function recordFailure(
  row: Pick<ScheduledListing, "id" | "attemptCount">,
  message: string,
  etsyListingId: string | null,
  now: Date,
  extraWhere: object = {},
): Promise<"retrying" | "failed" | "lost"> {
  const attempts = row.attemptCount + 1;
  const final = attempts >= MAX_PUBLISH_ATTEMPTS;
  const { count } = await prisma.scheduledListing.updateMany({
    where: { id: row.id, status: "publishing", ...extraWhere },
    data: {
      status: final ? "failed" : "pending",
      attemptCount: attempts,
      lastError: message,
      nextAttemptAt: final ? null : new Date(now.getTime() + retryDelayMs(attempts)),
      etsyListingId,
    },
  });
  if (count === 0) return "lost";
  return final ? "failed" : "retrying";
}

/** Returns rows stuck in "publishing" past {@link STALE_PUBLISHING_MS} to the retry cycle. */
export async function recoverStalePublishing(now: Date): Promise<number> {
  const cutoff = new Date(now.getTime() - STALE_PUBLISHING_MS);
  const stale = await prisma.scheduledListing.findMany({
    where: { status: "publishing", updatedAt: { lt: cutoff } },
    select: { id: true, attemptCount: true, etsyListingId: true },
  });
  let recovered = 0;
  for (const row of stale) {
    const outcome = await recordFailure(
      row,
      "Publishing was interrupted before it finished.",
      row.etsyListingId,
      now,
      { updatedAt: { lt: cutoff } },
    );
    if (outcome !== "lost") recovered++;
  }
  return recovered;
}

/**
 * Deletes a published row's images — only keys under its own
 * `scheduled/{userId}/{renderSetId}/` prefix. Anything else in `images`
 * (which should never happen) is refused and logged, so this can't reach a
 * user's own uploads. A storage failure is logged, not thrown: the listing is
 * already live, and orphaned objects are only a cost.
 */
export async function cleanupPublishedImages(
  row: Pick<ScheduledListing, "id" | "userId" | "renderSetId" | "images"> & { kind?: string; bulkEdit?: unknown },
  deleteImages: RunnerDeps["deleteImages"],
): Promise<number> {
  const bulk = row.kind === "bulk_edit";
  const keys = bulk ? bulkFileKeys(row.bulkEdit) : coerceScheduledImages(row.images).map((i) => i.key);
  const owns = bulk ? isOwnedScheduleKey : isOwnedRenderKey;
  const owned = keys.filter((key) => owns(key, row.userId, row.renderSetId));
  const refused = keys.filter((key) => !owned.includes(key));
  if (refused.length) {
    console.error(`[schedule] refusing to delete keys outside scheduled listing ${row.id}'s render set`, refused);
  }
  if (owned.length === 0) return 0;
  try {
    await deleteImages(owned);
    return owned.length;
  } catch (err) {
    console.error(`[schedule] couldn't delete images for published listing ${row.id}`, err);
    return 0;
  }
}

/** The stored media files a bulk edit was going to upload, without validating the whole job. */
function bulkFileKeys(bulkEdit: unknown): string[] {
  const updates = (bulkEdit as { updates?: unknown } | null)?.updates;
  return Array.isArray(updates) ? bulkEditFileKeys({ updates } as never) : [];
}

/** Listings a scheduled bulk edit writes between two saves of its results. */
export const BULK_EDIT_CHUNK = 10;

/** How a queued job drives one row (lib/jobs/handlers/scheduled-listing.ts). */
export interface ProcessOptions {
  /** Listings this attempt already tried — not tried again in it. */
  attempted?: number[];
  /** Called after each chunk with every listing this attempt has tried. */
  onChunk?: (attempted: number[]) => Promise<void>;
  /** True when the caller wants the row back: it stays "publishing" and the result is "continue". */
  shouldYield?: () => boolean;
}

/**
 * Applies a claimed bulk edit. Every listing gets its own result, recorded on
 * the row after every chunk of {@link BULK_EDIT_CHUNK}, so a listing Etsy
 * refuses never stops the others, a run that dies mid-way resumes after the
 * last saved chunk, and the ones that landed are never written again. A run
 * that didn't finish every listing counts as a failed attempt — the retry
 * writes only the listings still outstanding, the way a second Sync updates
 * retries only the failures.
 */
async function processBulkEdit(row: ScheduledListing, deps: RunnerDeps, now: Date, options: ProcessOptions = {}) {
  const parsed = parseScheduledBulkEdit(row.bulkEdit, { userId: row.userId, setId: row.renderSetId });
  if (!parsed.ok) {
    return recordFailure(row, `The scheduled edits are invalid: ${parsed.error}`, row.etsyListingId, now);
  }

  // One entry per listing the job covers, newest outcome winning.
  const byListing = new Map<number, ScheduledBulkResult>();
  for (const result of coerceBulkResults(row.results)) byListing.set(result.listingId, result);
  const attempted = new Set(options.attempted ?? []);

  for (;;) {
    const chunk = pendingBulkUpdates(parsed.job, [...byListing.values()])
      .filter((u) => !attempted.has(u.listingId))
      .slice(0, BULK_EDIT_CHUNK);
    if (chunk.length === 0) break;
    if (attempted.size > 0 && options.shouldYield?.()) return "continue" as const;

    let applied: ScheduledBulkResult[];
    try {
      applied = await deps.applyBulkEdit(row, chunk);
    } catch (err) {
      console.error(`[schedule] applying scheduled bulk edit ${row.id} failed`, err);
      return recordFailure(row, errorMessage(err), row.etsyListingId, now);
    }
    for (const result of applied) byListing.set(result.listingId, result);
    for (const update of chunk) attempted.add(update.listingId);
    const { count } = await prisma.scheduledListing.updateMany({
      where: { id: row.id, status: "publishing" },
      data: { results: [...byListing.values()] as unknown as Prisma.InputJsonValue },
    });
    if (count === 0) return "lost" as const;
    await options.onChunk?.([...attempted]);
  }

  const results = parsed.job.updates.map(
    (update) =>
      byListing.get(update.listingId) ?? {
        listingId: update.listingId,
        title: update.title,
        ok: false,
        error: "This listing wasn't reached.",
      },
  );
  await prisma.scheduledListing.updateMany({
    where: { id: row.id, status: "publishing" },
    data: { results: results as unknown as Prisma.InputJsonValue },
  });

  const failed = results.filter((r) => !r.ok);
  if (failed.length > 0) {
    const detail = failed
      .slice(0, 3)
      .map((r) => `${r.title || r.listingId}: ${r.error ?? "failed"}`)
      .join("; ");
    return recordFailure(row, `${summariseBulkResults(results)} ${detail}`, row.etsyListingId, now);
  }

  const { count } = await prisma.scheduledListing.updateMany({
    where: { id: row.id, status: "publishing" },
    data: { status: "published", lastError: null, nextAttemptAt: null },
  });
  if (count === 0) return "lost" as const;
  await cleanupPublishedImages(row, deps.deleteImages);
  return "published" as const;
}

async function processClaimed(row: ScheduledListing, deps: RunnerDeps, now: Date, options: ProcessOptions = {}) {
  if (row.kind === "bulk_edit") return processBulkEdit(row, deps, now, options);
  let etsyListingId = row.etsyListingId;
  try {
    etsyListingId = await deps.publish(row, {
      onListingCreated: async (listingId) => {
        etsyListingId = listingId;
        await prisma.scheduledListing.updateMany({
          where: { id: row.id, status: "publishing" },
          data: { etsyListingId: listingId },
        });
      },
    });
  } catch (err) {
    console.error(`[schedule] publishing scheduled listing ${row.id} failed`, err);
    return recordFailure(row, errorMessage(err), etsyListingId, now);
  }

  const { count } = await prisma.scheduledListing.updateMany({
    where: { id: row.id, status: "publishing" },
    data: { status: "published", etsyListingId, activeDraftId: null, lastError: null, nextAttemptAt: null },
  });
  if (count === 0) return "lost" as const;
  await cleanupPublishedImages(row, deps.deleteImages);
  if (row.draftId && deps.deleteDraft) {
    await deps.deleteDraft(row.userId, row.draftId).catch((err) => {
      console.error(`[schedule] deleting draft ${row.draftId} after publishing ${row.id} failed`, err);
    });
  }
  return "published" as const;
}

/**
 * One row, for the job queue: claims it (unless the job already holds it —
 * a resumed job whose worker died after the claim) and processes it.
 * "skipped" when the row isn't this caller's to process.
 */
export async function processScheduledListing(
  id: string,
  deps: RunnerDeps,
  options: ProcessOptions & { alreadyClaimed?: boolean; onClaimed?: () => Promise<void> } = {},
) {
  const now = deps.now();
  if (!options.alreadyClaimed) {
    if (!(await claimScheduledListing(id, now))) return "skipped" as const;
    await options.onClaimed?.();
  }
  const row = await prisma.scheduledListing.findUnique({ where: { id } });
  if (!row || row.status !== "publishing") return "skipped" as const;
  return processClaimed(row, deps, now, options);
}

/** Due rows, oldest first — what the worker queues. */
export async function findDueScheduledListings(now: Date, limit = 100) {
  return prisma.scheduledListing.findMany({
    where: dueWhere(now),
    orderBy: { scheduledAt: "asc" },
    take: limit,
    select: { id: true, userId: true, shopId: true },
  });
}

/** One pass over everything due now. Safe to run concurrently with itself. */
export async function runDueScheduledListings(
  deps: RunnerDeps,
  options: { limit?: number } = {},
): Promise<RunResult> {
  const now = deps.now();
  const result: RunResult = { published: [], retrying: [], failed: [], skipped: 0, recovered: 0 };
  result.recovered = await recoverStalePublishing(now);

  const due = await prisma.scheduledListing.findMany({
    where: dueWhere(now),
    orderBy: { scheduledAt: "asc" },
    take: options.limit ?? RUN_BATCH_LIMIT,
    select: { id: true },
  });

  for (const { id } of due) {
    if (!(await claimScheduledListing(id, now))) {
      result.skipped++;
      continue;
    }
    const row = await prisma.scheduledListing.findUnique({ where: { id } });
    if (!row) continue;
    const outcome = await processClaimed(row, deps, now);
    if (outcome === "published") result.published.push(id);
    else if (outcome === "retrying") result.retrying.push(id);
    else if (outcome === "failed") result.failed.push(id);
  }
  return result;
}
