/**
 * DB-backed CRUD for scheduled listings (see prisma/schema.prisma's
 * `ScheduledListing`). Server-only — pulls in Prisma; never import from a
 * "use client" file.
 *
 * Every read and write is scoped to the signed-in app `User` *and* the Etsy
 * shop they currently have active. A row belonging to another user — or to
 * the same user's other shop — behaves exactly like a row that doesn't
 * exist: "not found", never "forbidden", so ids can't be probed.
 *
 * Nothing here talks to Etsy or storage. Status changes that race the
 * background runner (lib/scheduling/runner.ts) go through a conditional
 * `updateMany`, so a row the runner has already moved to "publishing" can't
 * be rescheduled or cancelled underneath it.
 */

import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import type { PublishSpec } from "@/lib/etsy/publish-listing";
import { coerceScheduledImages } from "./publish-spec";
import {
  ACTIVE_STATUSES,
  EDITABLE_STATUSES,
  SCHEDULE_STATUSES,
  type ScheduledImage,
  type ScheduledListingSummary,
  type ScheduleStatus,
} from "./types";

export interface Scope {
  userId: string;
  shopId: string;
}

export type StoreResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: "not_found" | "conflict"; error: string };

/** Everything a schedule publishes — fixed when it's scheduled (or replaced from the editor). */
export interface ScheduleContent {
  publishSpec: PublishSpec;
  renderSetId: string;
  images: ScheduledImage[];
}

const ALREADY_SCHEDULED = "This draft is already scheduled. Reschedule it instead.";

interface ScheduledRow {
  id: string;
  draftId: string | null;
  scheduledAt: Date;
  timezone: string;
  status: string;
  images: Prisma.JsonValue;
  renderSetId: string | null;
  attemptCount: number;
  nextAttemptAt: Date | null;
  lastError: string | null;
  etsyListingId: string | null;
  draft: { title: string; hasThumbnail: boolean } | null;
}

const withDraft = { draft: { select: { title: true, hasThumbnail: true } } } as const;

/** Postgres unique violation, as Prisma reports it — here, a second active schedule for one draft. */
export function isUniqueViolation(err: unknown): boolean {
  return !!err && typeof err === "object" && (err as { code?: unknown }).code === "P2002";
}

function coerceStatus(value: string): ScheduleStatus {
  return (SCHEDULE_STATUSES as readonly string[]).includes(value) ? (value as ScheduleStatus) : "failed";
}

function toSummary(row: ScheduledRow): ScheduledListingSummary {
  let title = "Deleted draft";
  let thumbnailUrl: string | null = null;
  if (row.draft && row.draftId) {
    title = row.draft.title.trim() || "Untitled listing";
    if (row.draft.hasThumbnail) thumbnailUrl = `/api/drafts/${row.draftId}/assets/thumbnail/thumb`;
  }
  return {
    id: row.id,
    draftId: row.draftId,
    title,
    thumbnailUrl,
    scheduledAt: row.scheduledAt.toISOString(),
    timezone: row.timezone,
    status: coerceStatus(row.status),
    imageCount: coerceScheduledImages(row.images).length,
    attemptCount: row.attemptCount,
    nextAttemptAt: row.nextAttemptAt ? row.nextAttemptAt.toISOString() : null,
    lastError: row.lastError,
    etsyListingId: row.etsyListingId,
  };
}

async function findOwned(scope: Scope, id: string): Promise<ScheduledRow | null> {
  return prisma.scheduledListing.findFirst({
    where: { id, userId: scope.userId, shopId: scope.shopId },
    include: withDraft,
  });
}

const contentData = (content: ScheduleContent) => ({
  publishSpec: content.publishSpec as unknown as Prisma.InputJsonValue,
  renderSetId: content.renderSetId,
  images: content.images as unknown as Prisma.InputJsonValue,
});

/**
 * Schedules a draft to publish at `scheduledAt` with already-rendered
 * `content`. The caller has validated the time and content and confirmed the
 * images are in storage. Fails with "not_found" when the draft isn't the
 * caller's, and "conflict" when the database refuses a second active
 * schedule for the same draft.
 */
export async function createScheduledListing(
  scope: Scope,
  draftId: string,
  scheduledAt: Date,
  timezone: string,
  content: ScheduleContent,
): Promise<StoreResult<ScheduledListingSummary>> {
  const draft = await prisma.listingDraft.findFirst({
    where: { id: draftId, userId: scope.userId },
    select: { id: true },
  });
  if (!draft) return { ok: false, code: "not_found", error: "Draft not found." };

  try {
    const row = await prisma.scheduledListing.create({
      data: {
        userId: scope.userId,
        shopId: scope.shopId,
        draftId,
        activeDraftId: draftId,
        scheduledAt,
        timezone,
        ...contentData(content),
      },
      include: withDraft,
    });
    return { ok: true, value: toSummary(row) };
  } catch (err) {
    if (isUniqueViolation(err)) return { ok: false, code: "conflict", error: ALREADY_SCHEDULED };
    throw err;
  }
}

/**
 * Scheduled listings whose `scheduledAt` falls in `[from, to)`, soonest
 * first. Cancelled rows are left out — they no longer belong on the calendar.
 */
export async function listScheduledListings(
  scope: Scope,
  from: Date,
  to: Date,
): Promise<ScheduledListingSummary[]> {
  const rows = await prisma.scheduledListing.findMany({
    where: {
      userId: scope.userId,
      shopId: scope.shopId,
      scheduledAt: { gte: from, lt: to },
      status: { not: "cancelled" },
    },
    orderBy: { scheduledAt: "asc" },
    include: withDraft,
  });
  return rows.map(toSummary);
}

/** A draft's live schedule(s) in this shop — what the editor shows next to "Schedule for later". */
export async function listActiveSchedulesForDraft(
  scope: Scope,
  draftId: string,
): Promise<ScheduledListingSummary[]> {
  const rows = await prisma.scheduledListing.findMany({
    where: { userId: scope.userId, shopId: scope.shopId, draftId, status: { in: [...ACTIVE_STATUSES] } },
    orderBy: { scheduledAt: "asc" },
    include: withDraft,
  });
  return rows.map(toSummary);
}

export interface Rescheduled {
  summary: ScheduledListingSummary;
  /** The images the new content replaced — no longer referenced by any row, for the caller to delete. */
  superseded: { renderSetId: string | null; images: ScheduledImage[] } | null;
}

/**
 * Moves a pending or failed schedule to a new time. A failed row goes back
 * to "pending" with its attempts, backoff and error cleared — rescheduling is
 * how a failed publish is retried; its images were kept for exactly that.
 *
 * With `content` (a reschedule from the editor, which re-renders) the
 * listing and images are replaced too, and any Etsy listing a previous
 * attempt created is forgotten, since it was built from the old content.
 */
export async function rescheduleScheduledListing(
  scope: Scope,
  id: string,
  scheduledAt: Date,
  timezone: string,
  content?: ScheduleContent,
): Promise<StoreResult<Rescheduled>> {
  const before = await findOwned(scope, id);
  if (!before) return { ok: false, code: "not_found", error: "Scheduled listing not found." };
  if (!content && coerceScheduledImages(before.images).length === 0) {
    return {
      ok: false,
      code: "conflict",
      error: "This schedule has no rendered images. Open the listing and schedule it again from the editor.",
    };
  }

  const { count } = await prisma.scheduledListing.updateMany({
    where: { id, userId: scope.userId, shopId: scope.shopId, status: { in: [...EDITABLE_STATUSES] } },
    data: {
      status: "pending",
      scheduledAt,
      timezone,
      attemptCount: 0,
      nextAttemptAt: null,
      lastError: null,
      ...(content ? { ...contentData(content), etsyListingId: null } : {}),
    },
  });
  const row = await findOwned(scope, id);
  if (!row) return { ok: false, code: "not_found", error: "Scheduled listing not found." };
  if (count === 0) {
    return { ok: false, code: "conflict", error: `This listing is ${row.status} and can't be rescheduled.` };
  }
  const superseded =
    content && before.renderSetId !== content.renderSetId
      ? { renderSetId: before.renderSetId, images: coerceScheduledImages(before.images) }
      : null;
  return { ok: true, value: { summary: toSummary(row), superseded } };
}

export interface Cancelled {
  summary: ScheduledListingSummary;
  /** The images the cancelled schedule owned — nothing references them now, for the caller to delete. */
  released: { renderSetId: string | null; images: ScheduledImage[] } | null;
}

/**
 * Cancels a pending or failed schedule. The draft itself is untouched and can
 * be scheduled again (which re-renders its images from scratch), so the
 * cancelled schedule's own rendered images are dropped from the row and
 * handed back for the caller to delete from storage.
 */
export async function cancelScheduledListing(scope: Scope, id: string): Promise<StoreResult<Cancelled>> {
  const before = await findOwned(scope, id);
  const { count } = await prisma.scheduledListing.updateMany({
    where: { id, userId: scope.userId, shopId: scope.shopId, status: { in: [...EDITABLE_STATUSES] } },
    data: { status: "cancelled", activeDraftId: null, nextAttemptAt: null, renderSetId: null, images: [] },
  });
  const row = await findOwned(scope, id);
  if (!row) return { ok: false, code: "not_found", error: "Scheduled listing not found." };
  if (count === 0) {
    return { ok: false, code: "conflict", error: `This listing is ${row.status} and can't be cancelled.` };
  }
  const images = before ? coerceScheduledImages(before.images) : [];
  return {
    ok: true,
    value: {
      summary: toSummary(row),
      released: images.length > 0 ? { renderSetId: before!.renderSetId, images } : null,
    },
  };
}

/** Whether any of the user's schedules uses this render set — its images must then stay put. */
export async function isRenderSetInUse(userId: string, renderSetId: string): Promise<boolean> {
  const row = await prisma.scheduledListing.findFirst({
    where: { userId, renderSetId },
    select: { id: true },
  });
  return !!row;
}
