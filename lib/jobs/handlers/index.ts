import type { JobHandler } from "../worker";
import type { JobType } from "../types";
import { bulkSaveHandler } from "./bulk-save";
import { listingRefreshHandler } from "./listing-refresh";
import { scheduledListingHandler } from "./scheduled-listing";

/** The production handler for every job type. */
export function jobHandlers(): Record<JobType, JobHandler> {
  return {
    bulk_save: bulkSaveHandler(),
    listing_refresh: listingRefreshHandler(),
    scheduled_listing: scheduledListingHandler(),
  };
}
