import { handleWorkerRequest } from "@/lib/jobs/worker-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** The Etsy job worker — see lib/jobs/worker-route.ts. */
export async function POST(request: Request) {
  return handleWorkerRequest(request);
}
