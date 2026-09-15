import { resolveScheduleScope, storeResultResponse } from "@/lib/scheduling/request";
import { cancelScheduledListing } from "@/lib/scheduling/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * `POST /api/schedule/[id]/cancel` — cancels a pending or failed schedule.
 * The draft stays saved. 409 once it's publishing, published or already
 * cancelled; 404 when it isn't the caller's.
 */
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const resolved = await resolveScheduleScope();
  if (!resolved.ok) return resolved.response;
  const { id } = await params;
  const result = await cancelScheduledListing(resolved.scope, id);
  return storeResultResponse(result);
}
