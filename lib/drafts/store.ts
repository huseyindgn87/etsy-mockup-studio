/**
 * DB-backed CRUD for saved listing drafts (see prisma/schema.prisma's
 * `ListingDraft`). Server-only — pulls in Prisma and the R2 client; never
 * import from a "use client" file.
 *
 * Every read/write here is scoped to the calling Etsy user — a draft is only
 * ever visible to the shop that saved it.
 */

import type { ListingDraft, Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { deletePrefix, draftPrefix } from "@/lib/storage/r2";
import { DRAFT_TTL_DAYS } from "./constants";
import type { DraftSummary } from "./types";

export async function createDraft(etsyUserId: string): Promise<{ id: string }> {
  const row = await prisma.listingDraft.create({
    data: { etsyUserId, title: "", formData: {}, photosData: {} },
    select: { id: true },
  });
  return row;
}

export async function listDrafts(etsyUserId: string): Promise<DraftSummary[]> {
  const rows = await prisma.listingDraft.findMany({
    where: { etsyUserId },
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
export async function getDraftRow(etsyUserId: string, id: string): Promise<ListingDraft | null> {
  const row = await prisma.listingDraft.findUnique({ where: { id } });
  if (!row || row.etsyUserId !== etsyUserId) return null;
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
  etsyUserId: string,
  id: string,
  patch: DraftPatch,
): Promise<ListingDraft | null> {
  const owned = await getDraftRow(etsyUserId, id);
  if (!owned) return null;
  return prisma.listingDraft.update({ where: { id }, data: patch });
}

/** `true` on success, `false` when the draft didn't exist or belonged to someone else. */
export async function deleteDraft(etsyUserId: string, id: string): Promise<boolean> {
  const owned = await getDraftRow(etsyUserId, id);
  if (!owned) return false;
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
    where: { updatedAt: { lt: cutoff } },
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
