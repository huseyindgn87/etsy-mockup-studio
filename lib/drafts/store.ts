/**
 * DB-backed CRUD for saved listing drafts (see prisma/schema.prisma's
 * `ListingDraft`). Server-only — pulls in Prisma and the R2 client; never
 * import from a "use client" file.
 *
 * Every read/write here is scoped to the signed-in app `User` (not the Etsy
 * account, which can be disconnected/reconnected independently) — a draft is
 * only ever visible to the account that saved it.
 */

import type { ListingDraft, Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { deleteScheduledImages } from "@/lib/scheduling/render-storage";
import { ACTIVE_STATUSES, EDITABLE_STATUSES, type ScheduledImage } from "@/lib/scheduling/types";
import { deletePrefix, draftPrefix } from "@/lib/storage/r2";
import { DRAFT_TTL_DAYS } from "./constants";
import type { DraftSummary } from "./types";

export async function createDraft(userId: string): Promise<{ id: string }> {
  const row = await prisma.listingDraft.create({
    data: { userId, title: "", formData: {}, photosData: {} },
    select: { id: true },
  });
  return row;
}

export async function listDrafts(userId: string): Promise<DraftSummary[]> {
  const rows = await prisma.listingDraft.findMany({
    where: { userId },
    orderBy: { updatedAt: "desc" },
    select: { id: true, title: true, hasThumbnail: true, updatedAt: true },
  });
  return rows.map((r) => ({
    id: r.id,
    title: r.title.trim() || "Untitled listing",
    thumbnailUrl: r.hasThumbnail ? `/api/drafts/${r.id}/assets/thumbnail/thumb` : null,
    updatedAt: r.updatedAt.toISOString(),
  }));
}

/** `null` when the draft doesn't exist or belongs to a different user. */
export async function getDraftRow(userId: string, id: string): Promise<ListingDraft | null> {
  const row = await prisma.listingDraft.findUnique({ where: { id } });
  if (!row || row.userId !== userId) return null;
  return row;
}

export interface DraftPatch {
  title?: string;
  formData?: Prisma.InputJsonValue;
  photosData?: Prisma.InputJsonValue;
  hasThumbnail?: boolean;
  sourceMode?: string | null;
  sourceListingId?: string | null;
}

/** `null` when the draft doesn't exist or belongs to a different user. */
export async function saveDraft(
  userId: string,
  id: string,
  patch: DraftPatch,
): Promise<ListingDraft | null> {
  const owned = await getDraftRow(userId, id);
  if (!owned) return null;
  return prisma.listingDraft.update({ where: { id }, data: patch });
}

/** `true` on success, `false` when the draft didn't exist or belonged to someone else. */
export async function deleteDraft(userId: string, id: string): Promise<boolean> {
  const owned = await getDraftRow(userId, id);
  if (!owned) return false;
  // The row's FK would just null out `draftId`, leaving a pending schedule
  // pointing at nothing — cancel it explicitly instead, and delete the images
  // those schedules had rendered, since nothing will ever publish them now.
  // Published history keeps its row (see prisma/schema.prisma's
  // `ScheduledListing`), and so do its own already-deleted images.
  const cancelled = await prisma.scheduledListing.findMany({
    where: { draftId: id, userId, status: { in: [...EDITABLE_STATUSES] } },
    select: { renderSetId: true, images: true },
  });
  await prisma.scheduledListing.updateMany({
    where: { draftId: id, userId, status: { in: [...EDITABLE_STATUSES] } },
    data: { status: "cancelled", activeDraftId: null, renderSetId: null, images: [] },
  });
  for (const schedule of cancelled) {
    // Each key is re-checked against that schedule's own prefix before it is
    // deleted, so this can never reach the user's own uploads.
    await deleteScheduledImages(userId, {
      renderSetId: schedule.renderSetId,
      images: Array.isArray(schedule.images) ? (schedule.images as unknown as ScheduledImage[]) : [],
    });
  }
  // R2 cleanup is best-effort — an orphaned object is cheap; a draft the user
  // asked to delete but that a storage hiccup (or no R2 configured yet) leaves
  // stuck forever is a real, visible bug. Same tradeoff as sweepExpiredDrafts.
  await deletePrefix(draftPrefix(id)).catch(() => {});
  await prisma.listingDraft.delete({ where: { id } });
  return true;
}

/**
 * Deletes every draft untouched for {@link DRAFT_TTL_DAYS} days, and its R2
 * files. Safe to call often — cheap no-op when nothing has expired. Called
 * opportunistically from `GET /api/drafts` and exposed for an external cron
 * at `POST /api/drafts/sweep`.
 */
export async function sweepExpiredDrafts(): Promise<number> {
  const cutoff = new Date(Date.now() - DRAFT_TTL_DAYS * 24 * 60 * 60 * 1000);
  const expired = await prisma.listingDraft.findMany({
    // A scheduled draft is waiting to publish, not abandoned — never sweep it.
    where: {
      updatedAt: { lt: cutoff },
      scheduledListings: { none: { status: { in: [...ACTIVE_STATUSES] } } },
    },
    select: { id: true },
  });
  for (const d of expired) {
    await deletePrefix(draftPrefix(d.id)).catch(() => {
      // A stuck R2 delete shouldn't block the row cleanup below, or the next
      // draft in this sweep — an orphaned object is cheap; a DB that never
      // shrinks isn't.
    });
  }
  if (expired.length) {
    await prisma.listingDraft.deleteMany({ where: { id: { in: expired.map((d) => d.id) } } });
  }
  return expired.length;
}
