/**
 * Shared shapes for listing scheduling (prisma/schema.prisma's
 * `ScheduledListing`, lib/scheduling/store.ts, app/api/schedule, the
 * /schedule screen and the editor's "Schedule for later"). Dependency-free,
 * so both server routes and client components can import it.
 */

export const SCHEDULE_STATUSES = ["pending", "publishing", "published", "failed", "cancelled"] as const;
export type ScheduleStatus = (typeof SCHEDULE_STATUSES)[number];

/**
 * Statuses the user may still reschedule or cancel. Not "publishing" (the
 * runner is mid-flight), "published" or "cancelled" (both final).
 */
export const EDITABLE_STATUSES: readonly ScheduleStatus[] = ["pending", "failed"];

/**
 * Statuses that count as a draft's live schedule — a draft may have at most
 * one, so it can never be published twice. A "failed" row still counts: the
 * way to retry it is to reschedule it.
 */
export const ACTIVE_STATUSES: readonly ScheduleStatus[] = ["pending", "publishing", "failed"];

/** One scheduled listing as the API returns it. */
export interface ScheduledListingSummary {
  id: string;
  draftId: string | null;
  listingId: string | null;
  title: string;
  thumbnailUrl: string | null;
  /** ISO 8601, UTC. */
  scheduledAt: string;
  /** IANA timezone the time was picked in. */
  timezone: string;
  status: ScheduleStatus;
  attemptCount: number;
  lastError: string | null;
  etsyListingId: string | null;
}

/** The body of a create or reschedule request — a wall time in `timezone`. */
export interface ScheduleTimeInput {
  date: string;
  time: string;
  timezone: string;
}
