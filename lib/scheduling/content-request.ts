/**
 * Reads the content half of a create/reschedule request — `{ publishSpec,
 * renderSetId, images }` — for the scheduling routes. Server-only.
 */

import { NextResponse } from "next/server";
import { isR2Configured } from "@/lib/storage/r2";
import { parseScheduledImages, parseScheduledPublishSpec } from "./publish-spec";
import { missingImages } from "./render-storage";
import type { ScheduleContent, Scope } from "./store";

export const STORAGE_NOT_CONFIGURED =
  "Image storage (R2) isn't set up yet, so listings can't be scheduled. Publish now instead.";

export type ParsedContent = { ok: true; content: ScheduleContent } | { ok: false; response: NextResponse };

/** Validates the listing content and image list, and confirms every image actually reached storage. */
export async function parseScheduleContent(scope: Scope, body: Record<string, unknown>): Promise<ParsedContent> {
  const bad = (error: string, status = 400): ParsedContent => ({
    ok: false,
    response: NextResponse.json({ error }, { status }),
  });
  const spec = parseScheduledPublishSpec(body.publishSpec);
  if (!spec.ok) return bad(spec.error);
  const images = parseScheduledImages(body.images, scope.userId, body.renderSetId);
  if (!images.ok) return bad(images.error);
  if (!isR2Configured()) return bad(STORAGE_NOT_CONFIGURED, 503);

  const renderSetId = body.renderSetId as string;
  const missing = await missingImages(scope.userId, renderSetId, images.images);
  if (missing.length > 0) {
    return bad(`${missing.length} of the rendered images didn't finish uploading. Try scheduling again.`);
  }
  return { ok: true, content: { publishSpec: spec.spec, renderSetId, images: images.images } };
}
