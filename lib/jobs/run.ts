/**
 * Entry points that drive the worker (lib/jobs/worker.ts) with the production
 * handlers: the cron/CLI pass, and a route helping the queue along while its
 * user waits. Server-only.
 */

import type { EtsyJob } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { findDueScheduledListings, recoverStalePublishing } from "@/lib/scheduling/runner";
import { jobHandlers } from "./handlers";
import { enqueueJob } from "./queue";
import { isFinished, JOB_PRIORITY, type JobStatus } from "./types";
import { runWorker, type WorkerDeps, type WorkerResult } from "./worker";

/** Queues every scheduled listing that's due (one unfinished job per row). */
export async function enqueueDueScheduledListings(now: Date): Promise<number> {
  await recoverStalePublishing(now);
  const due = await findDueScheduledListings(now);
  for (const row of due) {
    await enqueueJob({
      userId: row.userId,
      shopId: row.shopId,
      type: "scheduled_listing",
      payload: { scheduledListingId: row.id },
      priority: JOB_PRIORITY.scheduled,
      activeKey: `scheduled:${row.id}`,
    });
  }
  return due.length;
}

export interface RunJobsResult extends WorkerResult {
  scheduledQueued: number;
}

/** One worker pass: queue what's due, then run slices until the queue is empty or time's up. */
export async function runJobsPass(
  options: { deadlineMs?: number; maxSlices?: number; deps?: Partial<WorkerDeps> } = {},
): Promise<RunJobsResult> {
  const scheduledQueued = await enqueueDueScheduledListings(new Date());
  const result = await runWorker({ handlers: jobHandlers(), ...options.deps }, options);
  return { scheduledQueued, ...result };
}

/**
 * Works the queue from inside a user's request until their job `jobId`
 * finishes or `budgetMs` runs out — taking jobs in the queue's own order, so
 * a request may well run someone else's slice first. Returns the job as it
 * then stands; the caller reports a still-unfinished job's status instead of
 * holding the request open.
 */
export async function helpUntilFinished(
  jobId: string,
  budgetMs: number,
  deps: Partial<WorkerDeps> = {},
): Promise<EtsyJob | null> {
  const now = deps.now ?? Date.now;
  const deadlineMs = now() + budgetMs;
  for (;;) {
    const job = await prisma.etsyJob.findUnique({ where: { id: jobId } });
    if (!job || isFinished(job.status as JobStatus) || now() >= deadlineMs) return job;
    const ran = await runWorker({ handlers: jobHandlers(), ...deps }, { maxSlices: 1, deadlineMs });
    if (ran.slices.length === 0) return prisma.etsyJob.findUnique({ where: { id: jobId } });
  }
}
