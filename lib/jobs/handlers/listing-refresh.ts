/**
 * `listing_refresh` jobs: a shop's full listings sync (lib/etsy/listing-sync.ts)
 * — the listings page's Refresh (interactive) or background work. The sync is
 * itself resumable: a run that dies keeps its finished batches, and the next
 * run skips listings it already has. Progress is checkpointed at most once a
 * second (and at each stage change), which also keeps the lease alive.
 */

import type { RefreshProgressEvent, SyncResult } from "@/lib/etsy/listing-sync";
import { syncShopListings } from "@/lib/etsy/listing-sync";
import { markShopSynced } from "@/lib/etsy/shop-connections";
import { withShopAccessToken } from "@/lib/scheduling/publisher";
import type { JobHandler } from "../worker";

export interface ListingRefreshDeps {
  withShopToken: <T>(userId: string, shopId: string, fn: () => Promise<T>) => Promise<T>;
  sync: (userId: string, shopId: string, onEvent: (event: RefreshProgressEvent) => void) => Promise<SyncResult>;
  markSynced: (userId: string, shopId: string) => Promise<void>;
}

const PROGRESS_INTERVAL_MS = 1000;

const defaultDeps: ListingRefreshDeps = {
  withShopToken: withShopAccessToken,
  sync: (userId, shopId, onEvent) => syncShopListings(userId, shopId, onEvent),
  markSynced: markShopSynced,
};

export function listingRefreshHandler(deps: ListingRefreshDeps = defaultDeps): JobHandler {
  return async (ctx) => {
    const shopId = (ctx.job.payload as { shopId?: unknown } | null)?.shopId;
    if (typeof shopId !== "string" || !shopId) return { status: "failed", error: "The job has no shop." };
    const userId = ctx.job.userId;

    let lastWriteMs = 0;
    let lastStage: string | undefined;
    let writes: Promise<void> = Promise.resolve();
    const onEvent = (event: RefreshProgressEvent) => {
      if (event.type !== "status" && event.type !== "progress") return;
      const stageChanged = event.stage !== lastStage;
      if (!stageChanged && ctx.now() - lastWriteMs < PROGRESS_INTERVAL_MS) return;
      lastStage = event.stage;
      lastWriteMs = ctx.now();
      const step = {
        stage: event.stage ?? null,
        message: event.message,
        done: event.type === "progress" ? event.fetched : null,
        total: event.type === "progress" ? event.total : null,
      };
      writes = writes.then(() => ctx.checkpoint(step));
    };

    const result = await deps.withShopToken(userId, shopId, () => deps.sync(userId, shopId, onEvent));
    await writes;
    await deps.markSynced(userId, shopId);
    await ctx.checkpoint({ message: `Refreshed ${result.total} listings`, done: result.total, total: result.total });
    return { status: "done", result };
  };
}
