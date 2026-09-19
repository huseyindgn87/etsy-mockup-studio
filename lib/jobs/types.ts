/**
 * Shapes shared by the job queue (server) and the status UI (client). No
 * server imports here.
 */

export const JOB_TYPES = ["bulk_save", "listing_refresh", "scheduled_listing"] as const;
export type JobType = (typeof JOB_TYPES)[number];

export const JOB_STATUSES = ["queued", "running", "done", "failed", "retrying"] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

/** Lower runs first. */
export const JOB_PRIORITY = {
  /** A user is waiting on it: a save, a bulk edit, a refresh they clicked. */
  interactive: 0,
  /** Scheduled publishes and scheduled bulk edits. */
  scheduled: 1,
  /** Nobody is waiting on it. */
  background: 2,
} as const;
export type JobPriority = (typeof JOB_PRIORITY)[keyof typeof JOB_PRIORITY];

/** The Etsy client's budget tier for each queue priority (lib/etsy/client.ts `DAILY_RESERVE`). */
export const ETSY_TIER_FOR_PRIORITY = {
  0: "interactive",
  1: "scheduled",
  2: "background",
} as const satisfies Record<JobPriority, string>;

/** What a job reports while it works — shown as "Running — 5 of 40". */
export interface JobProgressView {
  done: number | null;
  total: number | null;
  message: string | null;
}

/** A job as its owner sees it (`GET /api/jobs/[id]`). */
export interface JobView {
  id: string;
  type: JobType;
  status: JobStatus;
  priority: JobPriority;
  /** 1 = next to run. Only while queued or retrying. */
  position: number | null;
  attempts: number;
  maxAttempts: number;
  progress: JobProgressView | null;
  /** Why it failed, why it's retrying, or why it's waiting (Etsy's limit). */
  error: string | null;
  result: unknown;
  /** ISO 8601 — when a waiting job may run again. */
  runAfter: string;
  createdAt: string;
  finishedAt: string | null;
}

export const isFinished = (status: JobStatus) => status === "done" || status === "failed";

/**
 * How long a job a user is waiting on may show no change at all — status,
 * attempts, place in line, progress — before the UI stops waiting and reports
 * it as stalled. Longer than a worker lease (2 min), so a dead worker's job
 * gets its chance to be resumed first.
 */
export const JOB_STALL_MS = 3 * 60 * 1000;

export const JOB_STALLED_MESSAGE = "This job stopped making progress. Try again in a few minutes.";
