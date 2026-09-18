"use client";

import { describeJob } from "@/lib/jobs/describe";
import type { JobView } from "@/lib/jobs/types";

/**
 * A job's status in one line — queued with its place in line, running with
 * progress, done, or failed with the reason — plus a progress bar while it
 * runs with a known total.
 */
export function JobStatus({ job, className = "" }: { job: JobView; className?: string }) {
  const failed = job.status === "failed";
  const p = job.progress;
  const showBar = job.status === "running" && p?.done != null && p.total != null && p.total > 0;
  return (
    <div
      role={failed ? "alert" : "status"}
      data-job-status={job.status}
      className={`text-sm ${failed ? "text-red-600 dark:text-red-400" : "text-neutral-600 dark:text-neutral-300"} ${className}`}
    >
      <span>{describeJob(job)}</span>
      {showBar && (
        <progress className="ml-2 h-1.5 w-24 align-middle" max={p!.total!} value={p!.done!} aria-label="Job progress" />
      )}
    </div>
  );
}
