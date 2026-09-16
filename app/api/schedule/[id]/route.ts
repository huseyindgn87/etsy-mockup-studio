import { NextResponse } from "next/server";
import { parseScheduleContent } from "@/lib/scheduling/content-request";
import { deleteScheduledImages } from "@/lib/scheduling/render-storage";
import { resolveScheduleScope } from "@/lib/scheduling/request";
import { rescheduleScheduledListing } from "@/lib/scheduling/store";
import { parseScheduleTime } from "@/lib/scheduling/validate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * `PATCH /api/schedule/[id]` — reschedule: `{ date, time, timezone }`, same
 * rules as creating. Only a pending or failed schedule can move (a failed one
 * goes back to pending); 409 otherwise, 404 when it isn't the caller's.
 *
 * The editor also sends `{ publishSpec, renderSetId, images }` — freshly
 * rendered content replacing what was scheduled. The old images are then
 * deleted (they belonged only to this schedule).
 */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const resolved = await resolveScheduleScope();
  if (!resolved.ok) return resolved.response;
  const { id } = await params;

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Expected a JSON body." }, { status: 400 });
  }

  const time = parseScheduleTime(body);
  if (!time.ok) return NextResponse.json({ error: time.error }, { status: 400 });

  let content;
  if (body.renderSetId !== undefined || body.images !== undefined || body.publishSpec !== undefined) {
    const parsed = await parseScheduleContent(resolved.scope, body);
    if (!parsed.ok) return parsed.response;
    content = parsed.content;
  }

  const result = await rescheduleScheduledListing(resolved.scope, id, time.scheduledAt, time.timezone, content);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.code === "not_found" ? 404 : 409 });
  }
  if (result.value.superseded) await deleteScheduledImages(resolved.scope.userId, result.value.superseded);
  return NextResponse.json({ scheduledListing: result.value.summary });
}
