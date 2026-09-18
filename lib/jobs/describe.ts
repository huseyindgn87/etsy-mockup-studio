import type { JobView } from "./types";

function ordinal(n: number): string {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] || s[v] || s[0]}`;
}

function clockTime(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")} UTC`;
}

/**
 * One line saying where a job stands — what the status UI shows instead of a
 * bare spinner: "Queued — 3rd in line", "Running — 5 of 40", "Done",
 * "Failed: Etsy said no", "Retrying at 14:05 UTC — timeout".
 */
export function describeJob(job: JobView): string {
  switch (job.status) {
    case "queued": {
      const place = job.position == null ? "Queued" : job.position <= 1 ? "Queued — next in line" : `Queued — ${ordinal(job.position)} in line`;
      return job.error ? `${place}. ${job.error}` : place;
    }
    case "running": {
      const p = job.progress;
      if (p?.done != null && p.total != null) return `Running — ${p.done} of ${p.total}`;
      return p?.message ? `Running — ${p.message}` : "Running";
    }
    case "retrying":
      return `Retrying at ${clockTime(job.runAfter)}${job.error ? ` — ${job.error}` : ""}`;
    case "done":
      return "Done";
    case "failed":
      return `Failed: ${job.error || "unknown error"}`;
  }
}
