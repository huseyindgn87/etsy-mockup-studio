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
 * one (enforced by the unique `activeDraftId` column), so it can never be
 * published twice. A "failed" row still counts: the way to retry it is to
 * reschedule it.
 */
export const ACTIVE_STATUSES: readonly ScheduleStatus[] = ["pending", "publishing", "failed"];

/** Failed publish attempts before a scheduled listing is marked "failed" for good. */
export const MAX_PUBLISH_ATTEMPTS = 3;

/**
 * One image a scheduled publish sends to Etsy, stored in rank order on the
 * row. `key` is the R2 object (under `scheduled/{userId}/{renderSetId}/`,
 * see lib/scheduling/render-keys.ts) holding the image the browser rendered —
 * or a copy of the user's own photo — when the listing was scheduled.
 */
export interface ScheduledImage {
  key: string;
  filename: string;
  contentType: string;
  altText?: string;
}

/** One scheduled listing as the API returns it. */
export interface ScheduledListingSummary {
  id: string;
  draftId: string | null;
  title: string;
  thumbnailUrl: string | null;
  /** ISO 8601, UTC. */
  scheduledAt: string;
  /** IANA timezone the time was picked in. */
  timezone: string;
  status: ScheduleStatus;
  imageCount: number;
  attemptCount: number;
  /** ISO 8601 — when a failed attempt will be retried, while it waits out its backoff. */
  nextAttemptAt: string | null;
  lastError: string | null;
  etsyListingId: string | null;
}

/** The body of a create or reschedule request — a wall time in `timezone`. */
export interface ScheduleTimeInput {
  date: string;
  time: string;
  timezone: string;
}

/** What the editor uploads alongside a schedule: the listing content and the images it rendered. */
export interface ScheduleContentInput {
  /** The editor's Publish payload (`PublishSpec`), mode "new" or "copy". */
  publishSpec: unknown;
  /** The browser-generated id the images were uploaded under. */
  renderSetId: string;
  /** In rank order; image `i` was uploaded to slot `image-NN`. */
  images: { filename: string; contentType: string; altText?: string }[];
}
