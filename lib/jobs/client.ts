/**
 * Browser side of the job queue: follow a queued job until it ends. Each poll
 * asks the server to work the queue for a moment (`?help=1`), so a job moves
 * even with no cron running.
 */

import { isFinished, JOB_STALL_MS, JOB_STALLED_MESSAGE, type JobView } from "./types";

export const POLL_INTERVAL_MS = 1500;

export async function fetchJob(jobId: string, help = true): Promise<JobView> {
  const res = await fetch(`/api/jobs/${encodeURIComponent(jobId)}${help ? "?help=1" : ""}`, { cache: "no-store" });
  const body = (await res.json().catch(() => null)) as { job?: JobView; error?: string } | null;
  if (!res.ok || !body?.job) throw new Error(body?.error || `Couldn't read the job's status (${res.status}).`);
  return body.job;
}

/** Everything about a job that moves while it's alive. */
function jobStateKey(job: JobView): string {
  return JSON.stringify([job.status, job.attempts, job.position, job.progress, job.error, job.runAfter]);
}

/**
 * Polls until the job is done or failed, reporting every status seen. A job
 * that shows no change for `stallMs` (beyond a retry time it's waiting for)
 * throws {@link JOB_STALLED_MESSAGE} instead of being followed forever.
 */
export async function waitForJob(
  jobId: string,
  options: {
    onStatus?: (job: JobView) => void;
    intervalMs?: number;
    sleep?: (ms: number) => Promise<void>;
    stallMs?: number;
    now?: () => number;
  } = {},
): Promise<JobView> {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = options.now ?? Date.now;
  const stallMs = options.stallMs ?? JOB_STALL_MS;
  let lastKey = "";
  let changedAt = now();
  for (;;) {
    const job = await fetchJob(jobId);
    options.onStatus?.(job);
    if (isFinished(job.status)) return job;
    const key = jobStateKey(job);
    if (key !== lastKey) {
      lastKey = key;
      changedAt = now();
    }
    const waitingUntil = job.status === "retrying" ? Date.parse(job.runAfter) : 0;
    if (now() - Math.max(changedAt, waitingUntil) >= stallMs) throw new Error(JOB_STALLED_MESSAGE);
    await sleep(options.intervalMs ?? POLL_INTERVAL_MS);
  }
}
