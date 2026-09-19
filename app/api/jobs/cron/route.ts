import { NextResponse } from "next/server";
import { handleWorkerRequest } from "@/lib/jobs/worker-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** Scheduled cron job to process due jobs every 2 minutes. */
export async function GET(request: Request) {
  const authHeader = request.headers.get("authorization");
  if (!authHeader) {
    const secret = process.env.SCHEDULE_RUNNER_SECRET;
    if (!secret || secret.length < 32) {
      return NextResponse.json({ error: "Cron not configured." }, { status: 503 });
    }
    const bearerToken = `Bearer ${secret}`;
    const req = new Request(request.url, {
      method: "POST",
      headers: { authorization: bearerToken },
    });
    return handleWorkerRequest(req);
  }
  return handleWorkerRequest(new Request(request.url, { method: "POST", headers: request.headers }));
}

export const cron = "*/2 * * * *";
