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
 * Nothing here talks to Etsy. Status changes that race the (future)
 * background runner go through a conditional `updateMany`, so a row the
 * runner has already moved to "publishing" can't be rescheduled or cancelled
 * underneath it.
 */

import { prisma } from "@/lib/db/prisma";
import {
  ACTIVE_STATUSES,
  EDITABLE_STATUSES,
  SCHEDULE_STATUSES,
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

interface ScheduledRow {
  id: string;
  draftId: string | null;
  listingId: string | null;
  scheduledAt: Date;
  timezone: string;
  status: string;
  attemptCount: number;
  lastError: string | null;
  etsyListingId: string | null;
  draft: { title: string; hasThumbnail: boolean } | null;
}

const withDraft = { draft: { select: { title: true, hasThumbnail: true } } } as const;

function coerceStatus(value: string): ScheduleStatus {
  return (SCHEDULE_STATUSES as readonly string[]).includes(value) ? (value as ScheduleStatus) : "failed";
}

/** Title + thumbnail for rows that point at an Etsy listing rather than a draft, from the listings cache. */
async function listingDisplay(
  scope: Scope,
  rows: ScheduledRow[],
): Promise<Map<string, { title: string; thumbnailUrl: string | null }>> {
  const ids = [...new Set(rows.map((r) => r.listingId).filter((id): id is string => !!id))];
  if (ids.length === 0) return new Map();
  const listings = await prisma.listing.findMany({
    where: { userId: scope.userId, shopId: scope.shopId, listingId: { in: ids } },
    select: { listingId: true, title: true, thumbnailUrl: true },
  });
  return new Map(listings.map((l) => [l.listingId, { title: l.title, thumbnailUrl: l.thumbnailUrl }]));
}

function toSummary(
  row: ScheduledRow,
  listings: Map<string, { title: string; thumbnailUrl: string | null }>,
): ScheduledListingSummary {
  let title: string;
  let thumbnailUrl: string | null = null;
  if (row.draft && row.draftId) {
    title = row.draft.title.trim() || "Untitled listing";
    if (row.draft.hasThumbnail) thumbnailUrl = `/api/drafts/${row.draftId}/assets/thumbnail/thumb`;
  } else if (row.listingId) {
    const listing = listings.get(row.listingId);
    title = listing?.title ?? `Listing #${row.listingId}`;
    thumbnailUrl = listing?.thumbnailUrl ?? null;
  } else {
    title = "Deleted draft";
  }
  return {
    id: row.id,
    draftId: row.draftId,
    listingId: row.listingId,
    title,
    thumbnailUrl,
    scheduledAt: row.scheduledAt.toISOString(),
    timezone: row.timezone,
    status: coerceStatus(row.status),
    attemptCount: row.attemptCount,
    lastError: row.lastError,
    etsyListingId: row.etsyListingId,
  };
}

async function summarize(scope: Scope, rows: ScheduledRow[]): Promise<ScheduledListingSummary[]> {
  const listings = await listingDisplay(scope, rows);
  return rows.map((row) => toSummary(row, listings));
}

async function findOwned(scope: Scope, id: string): Promise<ScheduledRow | null> {
  return prisma.scheduledListing.findFirst({
    where: { id, userId: scope.userId, shopId: scope.shopId },
    include: withDraft,
  });
}

export type ScheduleTarget = { draftId: string } | { listingId: string };

/**
 * Schedules a draft (or a listing from this shop's cache) to publish at
 * `scheduledAt`. The caller has already validated the time
 * (lib/scheduling/validate.ts). Fails with "not_found" when the draft or
 * listing isn't the caller's, and "conflict" when it already has a live
 * schedule in this shop — reschedule that one instead.
 */
export async function createScheduledListing(
  scope: Scope,
  target: ScheduleTarget,
  scheduledAt: Date,
  timezone: string,
): Promise<StoreResult<ScheduledListingSummary>> {
  if ("draftId" in target) {
    const draft = await prisma.listingDraft.findFirst({
      where: { id: target.draftId, userId: scope.userId },
      select: { id: true },
    });
    if (!draft) return { ok: false, code: "not_found", error: "Draft not found." };
  } else {
    const listing = await prisma.listing.findFirst({
      where: { userId: scope.userId, shopId: scope.shopId, listingId: target.listingId, removedAt: null },
      select: { id: true },
    });
    if (!listing) return { ok: false, code: "not_found", error: "Listing not found." };
  }

  const existing = await prisma.scheduledListing.findFirst({
    where: { userId: scope.userId, shopId: scope.shopId, ...target, status: { in: [...ACTIVE_STATUSES] } },
    select: { id: true },
  });
  if (existing) {
    return {
      ok: false,
      code: "conflict",
      error: "This listing is already scheduled. Reschedule it instead.",
    };
  }

  const row = await prisma.scheduledListing.create({
    data: { userId: scope.userId, shopId: scope.shopId, ...target, scheduledAt, timezone },
    include: withDraft,
  });
  const [summary] = await summarize(scope, [row]);
  return { ok: true, value: summary };
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
  return summarize(scope, rows);
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
  return summarize(scope, rows);
}

/** Applies `data` only while the row is still editable; explains why not otherwise. */
async function updateIfEditable(
  scope: Scope,
  id: string,
  data: { status: ScheduleStatus; scheduledAt?: Date; timezone?: string; attemptCount?: number; lastError?: null },
  verb: string,
): Promise<StoreResult<ScheduledListingSummary>> {
  const { count } = await prisma.scheduledListing.updateMany({
    where: { id, userId: scope.userId, shopId: scope.shopId, status: { in: [...EDITABLE_STATUSES] } },
    data,
  });
  const row = await findOwned(scope, id);
  if (!row) return { ok: false, code: "not_found", error: "Scheduled listing not found." };
  if (count === 0) {
    return { ok: false, code: "conflict", error: `This listing is ${row.status} and can't be ${verb}.` };
  }
  const [summary] = await summarize(scope, [row]);
  return { ok: true, value: summary };
}

/**
 * Moves a pending or failed schedule to a new time. A failed row goes back
 * to "pending" with its attempt count and error cleared — rescheduling is
 * how a failed publish is retried.
 */
export async function rescheduleScheduledListing(
  scope: Scope,
  id: string,
  scheduledAt: Date,
  timezone: string,
): Promise<StoreResult<ScheduledListingSummary>> {
  return updateIfEditable(
    scope,
    id,
    { status: "pending", scheduledAt, timezone, attemptCount: 0, lastError: null },
    "rescheduled",
  );
}

/** Cancels a pending or failed schedule. The draft itself is untouched. */
export async function cancelScheduledListing(
  scope: Scope,
  id: string,
): Promise<StoreResult<ScheduledListingSummary>> {
  return updateIfEditable(scope, id, { status: "cancelled" }, "cancelled");
}
