/**
 * What the editor allows while a draft is scheduled, and what can be
 * scheduled at all. Dependency-free, so it's unit-testable without the editor.
 */

import type { ScheduledListingSummary } from "./types";

/**
 * Why Publish is disabled for a draft with this schedule, or `null` when it
 * isn't. A pending (or mid-publish) schedule will publish the draft on its
 * own — publishing it now as well would put the same listing on Etsy twice.
 */
export function publishBlockedBySchedule(schedule: Pick<ScheduledListingSummary, "status"> | null): string | null {
  if (!schedule) return null;
  if (schedule.status === "pending") {
    return "Publishing is off because this draft is scheduled to publish automatically — publishing it now too would create a duplicate listing. Cancel the schedule to publish now.";
  }
  if (schedule.status === "publishing") {
    return "Publishing is off because this draft's schedule is publishing it to Etsy right now.";
  }
  return null;
}

/** Why this editor session can't be scheduled, or `null` when it can. */
export function scheduleBlocker(params: { publishMode: "new" | "copy" | "existing"; videoCount: number }): string | null {
  if (params.publishMode === "existing") {
    return "Adding photos to an existing listing can't be scheduled — only new listings and copies can. Publish it now instead.";
  }
  if (params.videoCount > 0) {
    return "Listings with a video can't be scheduled yet. Remove the video to schedule, or publish now.";
  }
  return null;
}
