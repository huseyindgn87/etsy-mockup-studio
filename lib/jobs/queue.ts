/**
 * The Etsy job queue's records (prisma `EtsyJob`): adding jobs and reading
 * them back for their owner. The worker that runs them is lib/jobs/worker.ts.
 * Server-only.
 */

import { Prisma, type EtsyJob } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { queuePosition } from "./order";
import {
  JOB_STATUSES,
  JOB_TYPES,
  type JobPriority,
  type JobProgressView,
  type JobStatus,
  type JobType,
  type JobView,
} from "./types";

export const DEFAULT_MAX_ATTEMPTS = 3;

/** Unfinished and waiting to be claimed. */
export const WAITING_STATUSES: JobStatus[] = ["queued", "retrying"];

export interface NewJob {
  userId: string;
  shopId?: string | null;
  type: JobType;
  payload: unknown;
  priority: JobPriority;
  /** At most one unfinished job per key: enqueuing a second returns the first. */
  activeKey?: string;
  maxAttempts?: number;
  runAfter?: Date;
}

function isUniqueViolation(err: unknown): boolean {
  return !!err && typeof err === "object" && (err as { code?: unknown }).code === "P2002";
}

/** Adds a job, or returns the unfinished one already holding `activeKey`. */
export async function enqueueJob(job: NewJob): Promise<EtsyJob> {
  if (job.activeKey) {
    const existing = await prisma.etsyJob.findFirst({ where: { activeKey: job.activeKey } });
    if (existing) return existing;
  }
  try {
    return await prisma.etsyJob.create({
      data: {
        userId: job.userId,
        shopId: job.shopId ?? null,
        type: job.type,
        payload: job.payload as Prisma.InputJsonValue,
        priority: job.priority,
        status: "queued",
        maxAttempts: job.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
        activeKey: job.activeKey ?? null,
        ...(job.runAfter ? { runAfter: job.runAfter } : {}),
      },
    });
  } catch (err) {
    if (job.activeKey && isUniqueViolation(err)) {
      const existing = await prisma.etsyJob.findFirst({ where: { activeKey: job.activeKey } });
      if (existing) return existing;
    }
    throw err;
  }
}

async function lastServed(userIds: string[]): Promise<Map<string, number>> {
  if (userIds.length === 0) return new Map();
  const turns = await prisma.etsyJobTurn.findMany({ where: { userId: { in: userIds } } });
  return new Map(turns.map((t) => [t.userId, t.lastServedAt.getTime()]));
}

/** 1-based place in line for a waiting job (see {@link queuePosition}). */
export async function positionOf(job: Pick<EtsyJob, "id" | "userId" | "priority" | "createdAt">): Promise<number> {
  const [waiting, runningCount] = await Promise.all([
    prisma.etsyJob.findMany({
      where: { status: { in: WAITING_STATUSES }, priority: { lte: job.priority } },
      select: { id: true, userId: true, priority: true, createdAt: true },
    }),
    prisma.etsyJob.count({ where: { status: "running" } }),
  ]);
  const turns = await lastServed([...new Set(waiting.map((w) => w.userId).concat(job.userId))]);
  return queuePosition(job, waiting, runningCount, turns);
}

const coerceStatus = (s: string): JobStatus => ((JOB_STATUSES as readonly string[]).includes(s) ? (s as JobStatus) : "failed");
const coerceType = (t: string): JobType => ((JOB_TYPES as readonly string[]).includes(t) ? (t as JobType) : "bulk_save");
const numOrNull = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);

function progressView(raw: unknown): JobProgressView | null {
  if (!raw || typeof raw !== "object") return null;
  const p = raw as Record<string, unknown>;
  const view = {
    done: numOrNull(p.done),
    total: numOrNull(p.total),
    message: typeof p.message === "string" ? p.message : null,
  };
  return view.done == null && view.total == null && view.message == null ? null : view;
}

export async function toJobView(job: EtsyJob): Promise<JobView> {
  const status = coerceStatus(job.status);
  return {
    id: job.id,
    type: coerceType(job.type),
    status,
    priority: job.priority as JobPriority,
    position: WAITING_STATUSES.includes(status) ? await positionOf(job) : null,
    attempts: job.attempts,
    maxAttempts: job.maxAttempts,
    progress: progressView(job.progress),
    error: job.error,
    result: job.result ?? null,
    runAfter: job.runAfter.toISOString(),
    createdAt: job.createdAt.toISOString(),
    finishedAt: job.finishedAt ? job.finishedAt.toISOString() : null,
  };
}

/** The caller's own job, or `null` — another user's job is "not found". */
export async function getJobForUser(userId: string, id: string): Promise<EtsyJob | null> {
  return prisma.etsyJob.findFirst({ where: { id, userId } });
}

/** The caller's most recent jobs, newest first. */
export async function listJobsForUser(userId: string, limit = 20): Promise<JobView[]> {
  const rows = await prisma.etsyJob.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
  return Promise.all(rows.map(toJobView));
}
