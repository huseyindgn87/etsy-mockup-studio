import { NextResponse } from "next/server";
import { parseBulkUpdates } from "@/lib/etsy/bulk-edit";
import { etsyBudgetError } from "@/lib/etsy/client";
import { resolveListingScope } from "@/lib/etsy/listing-scope";
import { listStoredListingsByIds } from "@/lib/etsy/listing-store";
import type { BulkSaveJobResult } from "@/lib/jobs/handlers/bulk-save";
import { enqueueJob, toJobView } from "@/lib/jobs/queue";
import { helpUntilFinished } from "@/lib/jobs/run";
import { JOB_PRIORITY } from "@/lib/jobs/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** How long the request works the queue before answering with the job's status instead. */
export const INLINE_WAIT_MS = 20_000;

/**
 * `POST /api/etsy/listings/bulk/save` — `{ updates: [{ listingId, patch }] }`.
 *
 * The one place bulk editing writes to Etsy — as a `bulk_save` job
 * (lib/jobs/handlers/bulk-save.ts) at the priority of a user who's waiting.
 * The request then works the queue for up to {@link INLINE_WAIT_MS}: if the
 * job finishes, the answer is its per-listing results (`partial` when only a
 * listing's variation photos failed); if not — others are ahead, or Etsy's
 * limit is holding it — the answer is 202 with `{ jobId, job }` to poll at
 * `GET /api/jobs/[id]?help=1`.
 *
 * Every id is checked against the caller's own cached listings first, so a
 * listing belonging to another user (or to another of this user's shops) is
 * reported as not found and never sent to Etsy.
 */
export async function POST(request: Request) {
  const resolved = await resolveListingScope();
  if (!resolved.ok) return resolved.response;
  const { userId, shopId } = resolved.scope;

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Expected a JSON body." }, { status: 400 });
  }

  const parsed = parseBulkUpdates(body.updates);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });

  const owned = await listStoredListingsByIds(
    userId,
    shopId,
    parsed.value.map((u) => u.listingId),
  );
  const ownedIds = new Set(owned.map((l) => l.listingId));

  const toWrite = parsed.value.filter((u) => ownedIds.has(u.listingId));
  const notFound = parsed.value
    .filter((u) => !ownedIds.has(u.listingId))
    .map((u) => ({ listingId: u.listingId, ok: false as const, error: "Listing not found." }));

  const limited = await etsyBudgetError("interactive");
  if (limited) return NextResponse.json({ error: limited.message, retryAt: limited.retryAt.toISOString() }, { status: 429 });

  const summarise = (written: BulkSaveJobResult["results"]) => {
    const results: BulkSaveJobResult["results"] = [...written, ...notFound];
    return {
      results,
      saved: results.filter((r) => r.ok).length,
      partial: results.filter((r) => r.partial).length,
      failed: results.filter((r) => !r.ok && !r.partial).length,
    };
  };
  if (toWrite.length === 0) return NextResponse.json(summarise([]));

  const job = await enqueueJob({
    userId,
    shopId,
    type: "bulk_save",
    payload: { shopId, updates: toWrite },
    priority: JOB_PRIORITY.interactive,
  });
  const now = (await helpUntilFinished(job.id, INLINE_WAIT_MS)) ?? job;

  if (now.status === "done") {
    const result = now.result as unknown as BulkSaveJobResult;
    return NextResponse.json({ jobId: now.id, ...summarise(result.results) });
  }
  if (now.status === "failed") {
    return NextResponse.json({ jobId: now.id, error: now.error ?? "Saving failed." }, { status: 502 });
  }
  return NextResponse.json({ jobId: now.id, job: await toJobView(now) }, { status: 202 });
}
