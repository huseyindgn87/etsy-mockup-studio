import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { listJobsForUser } from "@/lib/jobs/queue";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** `GET /api/jobs` — the caller's 20 most recent Etsy jobs, newest first. */
export async function GET() {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  return NextResponse.json({ jobs: await listJobsForUser(userId) });
}
