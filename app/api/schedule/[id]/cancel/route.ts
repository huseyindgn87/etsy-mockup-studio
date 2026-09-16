import { NextResponse } from "next/server";
import { deleteScheduledImages } from "@/lib/scheduling/render-storage";
import { resolveScheduleScope } from "@/lib/scheduling/request";
import { cancelScheduledListing } from "@/lib/scheduling/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * `POST /api/schedule/[id]/cancel` — cancels a pending or failed schedule and
 * deletes the images it had rendered (nothing will publish them now; the
 * draft itself stays saved, and scheduling it again re-renders). 409 once
 * it's publishing, published or already cancelled; 404 when it isn't the
 * caller's.
 */
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const resolved = await resolveScheduleScope();
  if (!resolved.ok) return resolved.response;
  const { id } = await params;

  const result = await cancelScheduledListing(resolved.scope, id);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.code === "not_found" ? 404 : 409 });
  }
  if (result.value.released) await deleteScheduledImages(resolved.scope.userId, result.value.released);
  return NextResponse.json({ scheduledListing: result.value.summary });
}
