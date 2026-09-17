/**
 * Reads the bulk-edit half of `POST /api/schedule` — `{ updates, setId }` —
 * for the scheduling route. Server-only.
 *
 * Confirms three things before a job is stored: the edits themselves are
 * valid (lib/scheduling/bulk-job.ts), every listing is one of the caller's
 * own cached listings in the shop they have active (so a scheduled job can
 * never reach someone else's listing, the same rule every bulk route
 * follows), and every photo or video the edit adds actually reached storage.
 */

import { NextResponse } from "next/server";
import { listStoredListingsByIds } from "@/lib/etsy/listing-store";
import { isR2Configured, listKeys } from "@/lib/storage/r2";
import { bulkEditFileKeys, parseScheduledBulkEdit, type ScheduledBulkEdit } from "./bulk-job";
import { isRenderSetId, renderSetPrefix } from "./render-keys";
import type { Scope } from "./store";

export const MEDIA_STORAGE_NOT_CONFIGURED =
  "File storage (R2) isn't set up yet, so photo and video changes can't be scheduled. Remove them, or use Sync updates instead.";

export type ParsedBulkRequest =
  | { ok: true; job: ScheduledBulkEdit; setId: string | null }
  | { ok: false; response: NextResponse };

export async function parseBulkEditRequest(
  scope: Scope,
  body: Record<string, unknown>,
): Promise<ParsedBulkRequest> {
  const bad = (error: string, status = 400): ParsedBulkRequest => ({
    ok: false,
    response: NextResponse.json({ error }, { status }),
  });

  const setId = isRenderSetId(body.setId) ? body.setId : null;
  const parsed = parseScheduledBulkEdit({ updates: body.updates }, { userId: scope.userId, setId });
  if (!parsed.ok) return bad(parsed.error);

  const owned = await listStoredListingsByIds(
    scope.userId,
    scope.shopId,
    parsed.job.updates.map((u) => u.listingId),
  );
  const ownedIds = new Set(owned.map((l) => l.listingId));
  const foreign = parsed.job.updates.filter((u) => !ownedIds.has(u.listingId));
  if (foreign.length > 0) {
    return bad(
      `${foreign.length} of the selected listings ${foreign.length === 1 ? "isn't" : "aren't"} in this shop. Refresh the shop and try again.`,
      404,
    );
  }

  const keys = bulkEditFileKeys(parsed.job);
  if (keys.length > 0) {
    if (!setId) return bad("The uploaded photos are missing their storage id.");
    if (!isR2Configured()) return bad(MEDIA_STORAGE_NOT_CONFIGURED, 503);
    const present = new Set(await listKeys(renderSetPrefix(scope.userId, setId)));
    const missing = keys.filter((key) => !present.has(key));
    if (missing.length > 0) {
      return bad(`${missing.length} of the added photos didn't finish uploading. Try scheduling again.`);
    }
  }

  return { ok: true, job: parsed.job, setId: keys.length > 0 ? setId : null };
}
