/**
 * `scheduled_listing` jobs: one due `ScheduledListing` — a scheduled publish
 * or a scheduled bulk edit — through the existing runner
 * (lib/scheduling/runner.ts), which keeps its own attempts, backoff and
 * per-listing results on that row. The job checkpoints that it claimed the
 * row, and which listings of a bulk edit this attempt has tried, so a worker
 * that dies mid-way hands the same row to the next one: a publish reuses the
 * Etsy listing it already created, a bulk edit carries on after the last
 * saved chunk.
 */

import { applyScheduledBulkEdit } from "@/lib/scheduling/bulk-publisher";
import { publishScheduledListing } from "@/lib/scheduling/publisher";
import { processScheduledListing, type RunnerDeps } from "@/lib/scheduling/runner";
import { deleteObjects } from "@/lib/storage/r2";
import type { JobHandler } from "../worker";

const defaultDeps: RunnerDeps = {
  publish: publishScheduledListing,
  applyBulkEdit: applyScheduledBulkEdit,
  deleteImages: deleteObjects,
  now: () => new Date(),
};

export function scheduledListingHandler(deps: RunnerDeps = defaultDeps): JobHandler {
  return async (ctx) => {
    const id = (ctx.job.payload as { scheduledListingId?: unknown } | null)?.scheduledListingId;
    if (typeof id !== "string" || !id) return { status: "failed", error: "The job has no scheduled listing." };

    const attempted = Array.isArray(ctx.progress.attempted) ? (ctx.progress.attempted as number[]) : [];
    const outcome = await processScheduledListing(id, deps, {
      alreadyClaimed: ctx.progress.claimed === true,
      onClaimed: () => ctx.checkpoint({ claimed: true }),
      attempted,
      onChunk: (ids) => ctx.checkpoint({ attempted: ids, done: ids.length, message: `Applied ${ids.length} listings` }),
      shouldYield: ctx.shouldYield,
    });
    if (outcome === "continue") return { status: "continue" };
    return { status: "done", result: { outcome } };
  };
}
