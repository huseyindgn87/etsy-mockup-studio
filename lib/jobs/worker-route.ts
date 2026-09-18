import { NextResponse } from "next/server";
import { isAuthorizedRunnerRequest, RUNNER_SECRET_ENV, runnerSecret } from "@/lib/scheduling/runner-auth";
import { runJobsPass } from "./run";

/** Seconds a worker pass may use — under the route's `maxDuration`. */
export const WORKER_PASS_MS = 240_000;

/**
 * `POST /api/jobs/run` (and its older name `/api/schedule/run`): one worker
 * pass — queue due scheduled listings, then work the queue — for a cron
 * service, or `npm run jobs:run` locally. Not behind the app session:
 * requires `Authorization: Bearer <SCHEDULE_RUNNER_SECRET>`, and refuses
 * everything while that variable is unset. Jobs whose Etsy budget tier is
 * spent stay queued (`heldForBudget`) instead of spending attempts.
 */
export async function handleWorkerRequest(request: Request): Promise<Response> {
  const secret = runnerSecret();
  if (!secret) {
    console.error(`[jobs] ${RUNNER_SECRET_ENV} is missing or shorter than 32 characters — the worker is disabled.`);
    return NextResponse.json({ error: `The job worker is disabled: set ${RUNNER_SECRET_ENV}.` }, { status: 503 });
  }
  if (!isAuthorizedRunnerRequest(request.headers.get("authorization"), secret)) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }
  const result = await runJobsPass({ deadlineMs: Date.now() + WORKER_PASS_MS });
  return NextResponse.json(result);
}
