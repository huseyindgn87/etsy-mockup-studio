/**
 * `bulk_save` jobs: field patches for existing listings — what the bulk
 * editor's Sync updates and the single editor's Sync to Etsy send
 * (`POST /api/etsy/listings/bulk/save`). Server-only.
 *
 * Per slice, the next {@link BULK_SAVE_CHUNK} listings are read from Etsy in
 * one batch call, every field a patch sets to the value Etsy already holds is
 * dropped, and only what's left is written — a listing with nothing left
 * costs no write at all. Each listing's outcome is
 * checkpointed as soon as it's known, so a resumed job skips it; one whose
 * write landed but whose checkpoint didn't (the worker died in between) reads
 * back unchanged and is skipped too, rather than written twice.
 */

import type { BulkUpdate } from "@/lib/etsy/bulk-edit";
import { parseBulkUpdates, type BulkListingPatch } from "@/lib/etsy/bulk-edit";
import { applyBulkUpdate, type BulkResult } from "@/lib/etsy/bulk-apply";
import { withEtsyContext } from "@/lib/etsy/client";
import { fetchListingDetails, type BulkListingDetail } from "@/lib/etsy/listing-details";
import { applyStoredListingPatch } from "@/lib/etsy/listing-store";
import { withShopAccessToken } from "@/lib/scheduling/publisher";
import type { JobHandler } from "../worker";

export const BULK_SAVE_CHUNK = 10;

export interface BulkSavePayload {
  shopId: string;
  updates: BulkUpdate[];
}

/** One listing's outcome; `unchanged` when Etsy already held every value, so nothing was sent. */
export type BulkSaveResult = BulkResult & { unchanged?: boolean };

export interface BulkSaveJobResult {
  results: BulkSaveResult[];
  saved: number;
  partial: number;
  failed: number;
}

export interface BulkSaveDeps {
  withShopToken: <T>(userId: string, shopId: string, fn: () => Promise<T>) => Promise<T>;
  readListings: (listingIds: number[]) => Promise<BulkListingDetail[]>;
  apply: (shopId: number, update: BulkUpdate) => Promise<BulkResult>;
  mirror: (userId: string, shopId: string, patch: BulkListingPatch, result: BulkResult) => Promise<void>;
}

const sameList = (a: readonly unknown[], b: readonly unknown[]) => a.length === b.length && a.every((v, i) => v === b[i]);
const sameSet = (a: readonly number[], b: readonly number[]) => sameList([...a].sort(), [...b].sort());

/**
 * `patch` without the fields `live` already holds. Fields Etsy only accepts
 * together (who/when/supply, weight + unit, the three dimensions + unit) are
 * dropped only as a group. Fields a batch read can't show (attributes,
 * variation grids, variation photos, personalization, processing profile,
 * featured rank) are always kept — writing them again is harmless, since a
 * patch only ever sets values.
 */
export function withoutUnchanged(patch: BulkListingPatch, live: BulkListingDetail): BulkListingPatch {
  const out: BulkListingPatch = { ...patch };
  const drop = (keys: (keyof BulkListingPatch)[], equal: boolean) => {
    if (equal) for (const key of keys) delete out[key];
  };
  const group = (keys: (keyof BulkListingPatch)[], liveOf: Record<string, unknown>) => {
    const present = keys.filter((k) => patch[k] !== undefined);
    if (present.length > 0) drop(present, present.every((k) => patch[k] === liveOf[k]));
  };

  if (patch.title !== undefined) drop(["title"], patch.title === live.title);
  if (patch.description !== undefined) drop(["description"], patch.description === live.description);
  if (patch.tags) drop(["tags"], sameList(patch.tags, live.tags));
  if (patch.materials) drop(["materials"], sameList(patch.materials, live.materials));
  if (patch.productionPartnerIds) drop(["productionPartnerIds"], sameSet(patch.productionPartnerIds, live.productionPartnerIds));
  for (const key of ["taxonomyId", "shopSectionId", "shippingProfileId", "returnPolicyId", "shouldAutoRenew", "isTaxable"] as const) {
    if (patch[key] !== undefined) drop([key], patch[key] === live[key]);
  }
  group(["whoMade", "whenMade", "isSupply"], { whoMade: live.whoMade, whenMade: live.whenMade, isSupply: live.isSupply });
  group(["itemWeight", "itemWeightUnit"], { itemWeight: live.itemWeight, itemWeightUnit: live.itemWeightUnit });
  group(["itemLength", "itemWidth", "itemHeight", "itemDimensionsUnit"], {
    itemLength: live.itemLength,
    itemWidth: live.itemWidth,
    itemHeight: live.itemHeight,
    itemDimensionsUnit: live.itemDimensionsUnit,
  });
  // A listing without variations has one product, whose values the batch read shows.
  if (!live.hasVariations && !patch.variations) {
    if (patch.price !== undefined) drop(["price"], live.price != null && Math.abs(patch.price - live.price) < 0.005);
    if (patch.quantity !== undefined) drop(["quantity"], patch.quantity === live.quantity);
    if (patch.sku !== undefined) drop(["sku"], patch.sku === live.sku);
  }
  return out;
}

export function parseBulkSavePayload(raw: unknown): { ok: true; value: BulkSavePayload } | { ok: false; error: string } {
  const p = raw as { shopId?: unknown; updates?: unknown } | null;
  if (!p || typeof p.shopId !== "string" || !p.shopId) return { ok: false, error: "The job has no shop." };
  const parsed = parseBulkUpdates(p.updates);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  return { ok: true, value: { shopId: p.shopId, updates: parsed.value } };
}

export function summariseBulkSave(updates: BulkUpdate[], byId: Record<string, BulkSaveResult>): BulkSaveJobResult {
  const results = updates.map((u) => byId[String(u.listingId)]).filter((r): r is BulkSaveResult => r != null);
  return {
    results,
    saved: results.filter((r) => r.ok).length,
    partial: results.filter((r) => r.partial).length,
    failed: results.filter((r) => !r.ok && !r.partial).length,
  };
}

async function mirrorToCache(userId: string, shopId: string, patch: BulkListingPatch, result: BulkResult) {
  if (!result.ok && !result.partial) return;
  // Listing-side fields as Etsy confirmed them; price/quantity/SKU aren't in that response.
  const confirmed = result.confirmed;
  await applyStoredListingPatch(userId, shopId, result.listingId, {
    ...patch,
    ...(confirmed?.title !== undefined ? { title: confirmed.title } : {}),
    ...(confirmed?.shopSectionId != null ? { shopSectionId: confirmed.shopSectionId } : {}),
  });
}

const defaultDeps: BulkSaveDeps = {
  withShopToken: withShopAccessToken,
  readListings: fetchListingDetails,
  apply: applyBulkUpdate,
  mirror: mirrorToCache,
};

export function bulkSaveHandler(deps: BulkSaveDeps = defaultDeps): JobHandler {
  return async (ctx) => {
    const parsed = parseBulkSavePayload(ctx.job.payload);
    if (!parsed.ok) return { status: "failed", error: parsed.error };
    const { shopId, updates } = parsed.value;
    const userId = ctx.job.userId;

    const byId: Record<string, BulkSaveResult> = {
      ...((ctx.progress.results as Record<string, BulkSaveResult> | undefined) ?? {}),
    };
    const pending = () => updates.filter((u) => byId[String(u.listingId)] === undefined);
    const total = updates.length;
    const note = () => {
      const done = total - pending().length;
      return { results: byId, done, total, message: `Saved ${done} of ${total} listing${total === 1 ? "" : "s"}` };
    };

    if (pending().length > 0) {
      await deps.withShopToken(userId, shopId, async () => {
        while (pending().length > 0) {
          if (total - pending().length > 0 && ctx.shouldYield()) return;
          const chunk = pending().slice(0, BULK_SAVE_CHUNK);
          // Fresh from Etsy, never the read cache: this decides what to skip.
          const live = await withEtsyContext({ readCacheMs: 0 }, () => deps.readListings(chunk.map((u) => u.listingId)));
          const liveById = new Map(live.map((l) => [l.listingId, l]));
          for (const update of chunk) {
            // A listing the read didn't return is written as asked; Etsy's answer says why if it fails.
            const current = liveById.get(update.listingId);
            const patch = current ? withoutUnchanged(update.patch, current) : update.patch;
            let result: BulkSaveResult;
            if (Object.keys(patch).length === 0) {
              result = { listingId: update.listingId, ok: true, unchanged: true };
            } else {
              result = await deps.apply(Number(shopId), { listingId: update.listingId, patch });
              await deps.mirror(userId, shopId, patch, result);
            }
            byId[String(update.listingId)] = result;
            await ctx.checkpoint(note());
          }
        }
      });
    }

    if (pending().length > 0) return { status: "continue" };
    return { status: "done", result: summariseBulkSave(updates, byId) };
  };
}
