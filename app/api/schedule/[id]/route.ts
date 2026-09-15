import { NextResponse } from "next/server";
import { resolveScheduleScope, storeResultResponse } from "@/lib/scheduling/request";
import { rescheduleScheduledListing } from "@/lib/scheduling/store";
import { parseScheduleTime } from "@/lib/scheduling/validate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * `PATCH /api/schedule/[id]` — reschedule: `{ date, time, timezone }`, same
 * rules as creating. Only a pending or failed schedule can move (a failed one
 * goes back to pending); 409 otherwise, 404 when it isn't the caller's.
 */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const resolved = await resolveScheduleScope();
  if (!resolved.ok) return resolved.response;
  const { id } = await params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Expected a JSON body." }, { status: 400 });
  }

  const time = parseScheduleTime(body);
  if (!time.ok) return NextResponse.json({ error: time.error }, { status: 400 });

  const result = await rescheduleScheduledListing(resolved.scope, id, time.scheduledAt, time.timezone);
  return storeResultResponse(result);
}
