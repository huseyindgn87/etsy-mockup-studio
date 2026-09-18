import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { getJobForUser, toJobView } from "@/lib/jobs/queue";
import { helpUntilFinished } from "@/lib/jobs/run";
import { isFinished, type JobStatus } from "@/lib/jobs/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** How long one poll may work the queue before answering. */
const HELP_MS = 8_000;

/**
 * `GET /api/jobs/[id]` — the caller's job as a `JobView` (queued with its
 * place in line, running with progress, done, failed with the reason).
 * Another user's job is a 404. With `?help=1` an unfinished job's poll first
 * works the queue for a few seconds, so jobs move even before a cron exists.
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  const { id } = await params;

  let job = await getJobForUser(userId, id);
  if (!job) return NextResponse.json({ error: "Job not found." }, { status: 404 });
  if (new URL(request.url).searchParams.get("help") === "1" && !isFinished(job.status as JobStatus)) {
    job = (await helpUntilFinished(id, HELP_MS)) ?? job;
  }
  return NextResponse.json({ job: await toJobView(job) });
}
