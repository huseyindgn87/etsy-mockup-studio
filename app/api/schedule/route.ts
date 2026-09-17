import { type NextRequest, NextResponse } from "next/server";
import { parseBulkEditRequest } from "@/lib/scheduling/bulk-request";
import { parseScheduleContent } from "@/lib/scheduling/content-request";
import { resolveScheduleScope, storeResultResponse } from "@/lib/scheduling/request";
import {
  createScheduledBulkEdit,
  createScheduledListing,
  listActiveSchedulesForDraft,
  listScheduledListings,
} from "@/lib/scheduling/store";
import { parseRange, parseScheduleTime } from "@/lib/scheduling/validate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * `GET /api/schedule?from=<ISO>&to=<ISO>` — the signed-in user's scheduled
 * listings for their active shop with `scheduledAt` in `[from, to)`
 * (cancelled ones excluded), for the /schedule screen.
 *
 * `GET /api/schedule?draftId=<id>` — that draft's live schedule instead, for
 * the editor's "Schedule for later" button.
 */
export async function GET(request: NextRequest) {
  const resolved = await resolveScheduleScope();
  if (!resolved.ok) return resolved.response;

  const params = request.nextUrl.searchParams;
  const draftId = params.get("draftId");
  if (draftId) {
    const scheduledListings = await listActiveSchedulesForDraft(resolved.scope, draftId);
    return NextResponse.json({ scheduledListings });
  }

  const range = parseRange(params.get("from"), params.get("to"));
  if (!range.ok) return NextResponse.json({ error: range.error }, { status: 400 });
  const scheduledListings = await listScheduledListings(resolved.scope, range.from, range.to);
  return NextResponse.json({ scheduledListings });
}

/**
 * `POST /api/schedule` — two kinds of job.
 *
 * `{ kind: "bulk_edit", updates, setId?, date, time, timezone }` stores the
 * bulk editor's pending per-listing changes, to be applied by the runner at
 * that time through the same write path Sync updates uses. Every listing is
 * checked against the caller's own cached listings, and any photo the edit
 * adds must already be uploaded via `PUT /api/schedule/renders/...`.
 *
 * Otherwise `{ draftId, date, time, timezone, publishSpec,
 * renderSetId, images }`. `date`/`time` are a wall time in `timezone`, stored
 * as a UTC instant; it must be in the future. `images` (1–20, rank order)
 * must already be uploaded via `PUT /api/schedule/renders/...`. Only records
 * the schedule — nothing is sent to Etsy until the runner publishes it.
 * 201 with `{ scheduledListing }`; 404 for a draft that isn't the caller's;
 * 409 when the draft already has an active schedule.
 */
export async function POST(request: Request) {
  const resolved = await resolveScheduleScope();
  if (!resolved.ok) return resolved.response;

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Expected a JSON body." }, { status: 400 });
  }

  const time = parseScheduleTime(body);
  if (!time.ok) return NextResponse.json({ error: time.error }, { status: 400 });

  if (body.kind === "bulk_edit") {
    const job = await parseBulkEditRequest(resolved.scope, body);
    if (!job.ok) return job.response;
    const created = await createScheduledBulkEdit(
      resolved.scope,
      time.scheduledAt,
      time.timezone,
      job.job,
      job.setId,
    );
    return storeResultResponse(created, 201);
  }

  if (typeof body.draftId !== "string" || body.draftId === "") {
    return NextResponse.json({ error: "Provide the `draftId` to schedule." }, { status: 400 });
  }
  const content = await parseScheduleContent(resolved.scope, body);
  if (!content.ok) return content.response;

  const result = await createScheduledListing(
    resolved.scope,
    body.draftId,
    time.scheduledAt,
    time.timezone,
    content.content,
  );
  return storeResultResponse(result, 201);
}
