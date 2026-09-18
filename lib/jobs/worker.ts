/**
 * The job worker: claims queued Etsy jobs one at a time and runs a slice of
 * each. Driven by `POST /api/jobs/run` (a cron later; `npm run jobs:run`
 * locally) and, for a job a user is waiting on, inline by the route that
 * queued it. Any number of workers may run at once, on any instance.
 *
 * - **Order**: priority, then users in turn (lib/jobs/order.ts).
 * - **Budget**: a priority whose Etsy tier the daily budget refuses isn't
 *   claimed at all — its jobs stay queued, spending no attempt — so what's
 *   reserved for users stays theirs (lib/etsy/client.ts `DAILY_RESERVE`).
 * - **Leases**: a claim sets a random `lockToken` and `lockedUntil`; every
 *   write about the job requires that token, and every checkpoint extends
 *   the lease. A worker that dies leaves its lease to run out; the next claim
 *   counts that as a failed attempt and the handler resumes from the job's
 *   checkpointed `progress`, so finished work isn't done again.
 * - **Slices**: a handler works for at most {@link SLICE_MS}, checkpoints and
 *   answers "continue"; the job goes back in the queue and waits its turn.
 */

import { randomUUID } from "node:crypto";
import { Prisma, type EtsyJob } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { EtsyLimitError, etsyBudgetRetryAt, withEtsyContext, type EtsyPriority } from "@/lib/etsy/client";
import { orderCandidates } from "./order";
import { WAITING_STATUSES } from "./queue";
import { ETSY_TIER_FOR_PRIORITY, JOB_PRIORITY, type JobPriority } from "./types";

export const LEASE_MS = 2 * 60 * 1000;
export const SLICE_MS = 20 * 1000;
export const RETRY_BASE_MS = 30 * 1000;
const ALL_PRIORITIES = Object.values(JOB_PRIORITY) as JobPriority[];

/** Backoff before retry after the n-th failed attempt: 30 s, 2 min, 8 min… */
export function jobRetryDelayMs(failedAttempts: number): number {
  return RETRY_BASE_MS * 4 ** Math.max(0, failedAttempts - 1);
}

/** This worker's lease on the job was taken over — it must stop without writing. */
export class LeaseLostError extends Error {
  constructor(jobId: string) {
    super(`Lost the lease on job ${jobId}.`);
    this.name = "LeaseLostError";
  }
}

export interface JobContext {
  job: EtsyJob;
  /** The handler's own checkpoint from earlier slices (or a crashed run), `{}` at first. */
  progress: Record<string, unknown>;
  now: () => number;
  /** True once the slice has used its time: checkpoint and answer "continue". */
  shouldYield: () => boolean;
  /** Saves `progress` (merged over the last checkpoint) and extends the lease. Throws {@link LeaseLostError}. */
  checkpoint: (progress: Record<string, unknown>) => Promise<void>;
}

export type JobOutcome =
  | { status: "done"; result?: unknown }
  | { status: "continue" }
  /** Won't succeed on a retry (bad payload, shop disconnected…). */
  | { status: "failed"; error: string };

export type JobHandler = (ctx: JobContext) => Promise<JobOutcome>;

export interface WorkerDeps {
  handlers: Partial<Record<string, JobHandler>>;
  now?: () => number;
  /** When work of an Etsy tier may start again, or `null` if the daily budget allows it now. */
  budgetRetryAt?: (tier: EtsyPriority) => Promise<Date | null>;
  sliceMs?: number;
  leaseMs?: number;
}

export interface SliceReport {
  jobId: string;
  userId: string;
  type: string;
  outcome: "done" | "continue" | "retrying" | "failed" | "waiting" | "lost";
}

export interface WorkerResult {
  slices: SliceReport[];
  /** Priorities left queued because the daily Etsy budget is kept for higher ones. */
  heldForBudget: JobPriority[];
}


function errorMessage(err: unknown): string {
  return ((err instanceof Error ? err.message : String(err)) || "Unknown error").slice(0, 1000);
}

/** Claimable now: waiting and due, or running with a lease that ran out (its worker died). */
function claimableWhere(now: Date) {
  return {
    OR: [
      { status: { in: WAITING_STATUSES }, runAfter: { lte: now } },
      { status: "running", lockedUntil: { lt: now } },
    ],
  };
}

async function allowedPriorities(budgetRetryAt: NonNullable<WorkerDeps["budgetRetryAt"]>) {
  const allowed: JobPriority[] = [];
  const held: JobPriority[] = [];
  for (const p of ALL_PRIORITIES) ((await budgetRetryAt(ETSY_TIER_FOR_PRIORITY[p])) ? held : allowed).push(p);
  return { allowed, held };
}

/**
 * Claims the next job for this worker: each user's best claimable job, in
 * {@link orderCandidates} order, the first conditional update that matches
 * wins. `null` when nothing is claimable.
 */
export async function claimNextJob(
  now: Date,
  priorities: JobPriority[],
  leaseMs = LEASE_MS,
): Promise<EtsyJob | null> {
  if (priorities.length === 0) return null;
  const candidates = await prisma.etsyJob.findMany({
    where: { priority: { in: priorities }, ...claimableWhere(now) },
    orderBy: [{ priority: "asc" }, { createdAt: "asc" }],
    distinct: ["userId"],
  });
  if (candidates.length === 0) return null;
  const turns = await prisma.etsyJobTurn.findMany({ where: { userId: { in: candidates.map((c) => c.userId) } } });
  const served = new Map(turns.map((t) => [t.userId, t.lastServedAt.getTime()]));

  for (const candidate of orderCandidates(candidates, served)) {
    const crashed = candidate.status === "running";
    const lockToken = randomUUID();
    const { count } = await prisma.etsyJob.updateMany({
      where: { id: candidate.id, attempts: candidate.attempts, ...claimableWhere(now) },
      data: {
        status: "running",
        lockToken,
        lockedUntil: new Date(now.getTime() + leaseMs),
        startedAt: candidate.startedAt ?? now,
        ...(crashed ? { attempts: candidate.attempts + 1, error: "The worker stopped before finishing; resuming." } : {}),
      },
    });
    if (count !== 1) continue;
    await prisma.etsyJobTurn.upsert({
      where: { userId: candidate.userId },
      create: { userId: candidate.userId, lastServedAt: now },
      update: { lastServedAt: now },
    });
    const job = await prisma.etsyJob.findUnique({ where: { id: candidate.id } });
    if (!job) continue;
    if (crashed && job.attempts >= job.maxAttempts) {
      await finish(job, lockToken, now, { status: "failed", error: "The job was interrupted too many times." });
      continue;
    }
    return job;
  }
  return null;
}

type Finish =
  | { status: "done"; result?: unknown }
  | { status: "failed"; error: string; attempts?: number }
  | { status: "queued"; runAfter: Date; error: string | null; attempts?: number }
  | { status: "retrying"; runAfter: Date; error: string; attempts: number };

async function finish(job: EtsyJob, lockToken: string, now: Date, to: Finish): Promise<boolean> {
  const ended = to.status === "done" || to.status === "failed";
  const { count } = await prisma.etsyJob.updateMany({
    where: { id: job.id, lockToken },
    data: {
      status: to.status,
      lockToken: null,
      lockedUntil: null,
      ...(ended ? { finishedAt: now, activeKey: null } : { runAfter: to.runAfter }),
      ...(to.status === "done"
        ? { error: null, result: to.result == null ? Prisma.JsonNull : (to.result as Prisma.InputJsonValue) }
        : { error: to.error }),
      ...("attempts" in to && to.attempts !== undefined ? { attempts: to.attempts } : {}),
    },
  });
  return count === 1;
}

/** Runs one slice of a claimed job and records what came of it. */
export async function runJobSlice(job: EtsyJob, deps: WorkerDeps, sliceEndMs: number): Promise<SliceReport["outcome"]> {
  const nowMs = deps.now ?? Date.now;
  const leaseMs = deps.leaseMs ?? LEASE_MS;
  const lockToken = job.lockToken as string;
  const handler = deps.handlers[job.type];

  if (!handler) {
    await finish(job, lockToken, new Date(nowMs()), { status: "failed", error: `Unknown job type "${job.type}".` });
    return "failed";
  }

  let progress: Record<string, unknown> =
    job.progress && typeof job.progress === "object" && !Array.isArray(job.progress) ? { ...(job.progress as object) } : {};
  const ctx: JobContext = {
    job,
    progress,
    now: nowMs,
    shouldYield: () => nowMs() >= sliceEndMs,
    checkpoint: async (next) => {
      progress = { ...progress, ...next };
      ctx.progress = progress;
      const { count } = await prisma.etsyJob.updateMany({
        where: { id: job.id, lockToken },
        data: { progress: progress as Prisma.InputJsonValue, lockedUntil: new Date(nowMs() + leaseMs) },
      });
      if (count !== 1) throw new LeaseLostError(job.id);
    },
  };

  let outcome: JobOutcome;
  try {
    const tier = ETSY_TIER_FOR_PRIORITY[job.priority as JobPriority] ?? "background";
    outcome = await withEtsyContext({ userId: job.userId, priority: tier }, () => handler(ctx));
  } catch (err) {
    const now = new Date(nowMs());
    if (err instanceof LeaseLostError) return "lost";
    if (err instanceof EtsyLimitError) {
      // Not the job's fault: wait for the budget without spending an attempt.
      const ok = await finish(job, lockToken, now, { status: "queued", runAfter: err.retryAt, error: err.message });
      return ok ? "waiting" : "lost";
    }
    console.error(`[jobs] ${job.type} ${job.id} user=${job.userId} failed`, err);
    const attempts = job.attempts + 1;
    if (attempts >= job.maxAttempts) {
      const ok = await finish(job, lockToken, now, { status: "failed", error: errorMessage(err), attempts });
      return ok ? "failed" : "lost";
    }
    const ok = await finish(job, lockToken, now, {
      status: "retrying",
      runAfter: new Date(now.getTime() + jobRetryDelayMs(attempts)),
      error: errorMessage(err),
      attempts,
    });
    return ok ? "retrying" : "lost";
  }

  const now = new Date(nowMs());
  if (outcome.status === "continue") {
    const ok = await finish(job, lockToken, now, { status: "queued", runAfter: now, error: null });
    return ok ? "continue" : "lost";
  }
  const ok = await finish(job, lockToken, now, outcome);
  return ok ? outcome.status : "lost";
}

/**
 * Claims and runs slices until nothing is claimable, `maxSlices` ran, or
 * `deadlineMs` (epoch ms) passed. Safe to run concurrently with itself.
 */
export async function runWorker(
  deps: WorkerDeps,
  options: { maxSlices?: number; deadlineMs?: number } = {},
): Promise<WorkerResult> {
  const nowMs = deps.now ?? Date.now;
  const sliceMs = deps.sliceMs ?? SLICE_MS;
  const maxSlices = options.maxSlices ?? 25;
  const deadline = options.deadlineMs ?? nowMs() + 4 * 60 * 1000;
  const result: WorkerResult = { slices: [], heldForBudget: [] };

  while (result.slices.length < maxSlices && nowMs() < deadline) {
    const { allowed, held } = await allowedPriorities(deps.budgetRetryAt ?? etsyBudgetRetryAt);
    result.heldForBudget = held;
    const job = await claimNextJob(new Date(nowMs()), allowed, deps.leaseMs);
    if (!job) break;
    const outcome = await runJobSlice(job, deps, Math.min(nowMs() + sliceMs, deadline));
    result.slices.push({ jobId: job.id, userId: job.userId, type: job.type, outcome });
  }
  return result;
}
