/**
 * Which job runs next, and where a queued job stands — pure, so the rules are
 * unit-tested directly.
 *
 * Priority first (a user waiting beats a schedule beats background work).
 * Within a priority, users take turns: the user the worker served longest ago
 * goes first, then that user's oldest job. A job never holds the worker for
 * long — handlers hand back after a slice (lib/jobs/worker.ts) and the job
 * rejoins the queue — so one user's 5,000-listing job gets one turn per round
 * like everyone else's.
 */

export interface QueueEntry {
  id: string;
  userId: string;
  priority: number;
  createdAt: Date;
}

/** Candidates in the order the worker should try to claim them. */
export function orderCandidates<T extends QueueEntry>(candidates: T[], lastServedMs: Map<string, number>): T[] {
  const served = (userId: string) => lastServedMs.get(userId) ?? Number.NEGATIVE_INFINITY;
  return [...candidates].sort(
    (a, b) =>
      a.priority - b.priority ||
      served(a.userId) - served(b.userId) ||
      a.createdAt.getTime() - b.createdAt.getTime() ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}

export function pickNextJob<T extends QueueEntry>(candidates: T[], lastServedMs: Map<string, number>): T | null {
  return orderCandidates(candidates, lastServedMs)[0] ?? null;
}

/**
 * 1-based place in line for `job` among `waiting` (every unfinished job not
 * currently running, `job` included) with `running` jobs counted as ahead.
 * Better-priority jobs are all ahead. At the same priority, round-robin means
 * that before this user's k-th waiting job (k = 0 for their oldest), every
 * other user gets up to k turns — plus one more if their turn comes before
 * this user's.
 */
export function queuePosition(
  job: QueueEntry,
  waiting: QueueEntry[],
  runningCount: number,
  lastServedMs: Map<string, number>,
): number {
  const served = (userId: string) => lastServedMs.get(userId) ?? Number.NEGATIVE_INFINITY;
  const byTime = (a: QueueEntry, b: QueueEntry) =>
    a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

  let ahead = runningCount;
  const samePriority = new Map<string, QueueEntry[]>();
  for (const other of waiting) {
    if (other.id === job.id) continue;
    if (other.priority < job.priority) ahead++;
    else if (other.priority === job.priority) {
      const list = samePriority.get(other.userId) ?? [];
      list.push(other);
      samePriority.set(other.userId, list);
    }
  }

  const mine = (samePriority.get(job.userId) ?? []).sort(byTime);
  const k = mine.filter((j) => byTime(j, job) < 0).length;
  ahead += k;

  const myOldest = [...mine, job].sort(byTime)[0];
  for (const [userId, jobs] of samePriority) {
    if (userId === job.userId) continue;
    const theirOldest = jobs.sort(byTime)[0];
    const turnFirst =
      served(userId) < served(job.userId) ||
      (served(userId) === served(job.userId) && byTime(theirOldest, myOldest) < 0);
    ahead += Math.min(jobs.length, k + (turnFirst ? 1 : 0));
  }
  return ahead + 1;
}
