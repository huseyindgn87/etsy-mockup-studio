import { NextResponse } from "next/server";
import { publishScheduledListing } from "@/lib/scheduling/publisher";
import { runDueScheduledListings } from "@/lib/scheduling/runner";
import { isAuthorizedRunnerRequest, RUNNER_SECRET_ENV, runnerSecret } from "@/lib/scheduling/runner-auth";
import { deleteObjects } from "@/lib/storage/r2";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * `POST /api/schedule/run` — publishes every scheduled listing that's due
 * (lib/scheduling/runner.ts) and returns what happened. For a cron service,
 * or `npm run schedule:run` locally.
 *
 * Not behind the app session (lib/auth/route-guard.ts lets it through): it
 * requires `Authorization: Bearer <SCHEDULE_RUNNER_SECRET>`, and refuses
 * everything while that variable is unset.
 */
export async function POST(request: Request) {
  const secret = runnerSecret();
  if (!secret) {
    console.error(`[schedule] ${RUNNER_SECRET_ENV} is missing or shorter than 32 characters — the runner is disabled.`);
    return NextResponse.json(
      { error: `The scheduled-listing runner is disabled: set ${RUNNER_SECRET_ENV}.` },
      { status: 503 },
    );
  }
  if (!isAuthorizedRunnerRequest(request.headers.get("authorization"), secret)) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  const result = await runDueScheduledListings({
    publish: publishScheduledListing,
    deleteImages: deleteObjects,
    now: () => new Date(),
  });
  return NextResponse.json(result);
}
