/**
 * Browser side of the job queue: follow a queued job until it ends. Each poll
 * asks the server to work the queue for a moment (`?help=1`), so a job moves
 * even with no cron running.
 */

import { isFinished, type JobView } from "./types";

export const POLL_INTERVAL_MS = 1500;

export async function fetchJob(jobId: string, help = true): Promise<JobView> {
  const res = await fetch(`/api/jobs/${encodeURIComponent(jobId)}${help ? "?help=1" : ""}`, { cache: "no-store" });
  const body = (await res.json().catch(() => null)) as { job?: JobView; error?: string } | null;
  if (!res.ok || !body?.job) throw new Error(body?.error || `Couldn't read the job's status (${res.status}).`);
  return body.job;
}

/** Polls until the job is done or failed, reporting every status seen. */
export async function waitForJob(
  jobId: string,
  options: { onStatus?: (job: JobView) => void; intervalMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<JobView> {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (;;) {
    const job = await fetchJob(jobId);
    options.onStatus?.(job);
    if (isFinished(job.status)) return job;
    await sleep(options.intervalMs ?? POLL_INTERVAL_MS);
  }
}
