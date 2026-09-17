/**
 * Applies one claimed **scheduled bulk edit** to Etsy, for the runner
 * (lib/scheduling/runner.ts). Server-only.
 *
 * Every listing goes through exactly the path Sync updates uses — its media
 * first (`planListingMediaEdit` + `applyListingMediaEdit`, as
 * `POST /api/etsy/listings/[id]/media` does), then its field patch through
 * `applyBulkUpdates`, which includes the variation-photo step — and the
 * cached listing row is mirrored the same way the save route mirrors it.
 *
 * One listing never stops the others: each returns its own result, and a
 * listing that fails is reported with the reason, exactly as the screen
 * reports it. The media step is independent of the field step, so a job whose
 * stored photos can't be read (R2 isn't provisioned yet — see AGENTS.md)
 * still applies every text, inventory and variation change and says why the
 * photos didn't land.
 *
 * There's no browser session in a runner, so Etsy is called with a fresh
 * access token from the shop connection's stored refresh token.
 */

import type { ScheduledListing } from "@prisma/client";
import { applyBulkUpdates } from "@/lib/etsy/bulk-apply";
import { fetchListingDetails } from "@/lib/etsy/listing-details";
import { uploadListingImage } from "@/lib/etsy/listing-images";
import {
  applyListingMediaEdit,
  isEmptyMediaPlan,
  planListingMediaEdit,
  type ImagePlacement,
  type VideoPlacement,
} from "@/lib/etsy/listing-media-edit";
import { applyStoredListingPatch, listStoredListingsByIds } from "@/lib/etsy/listing-store";
import { uploadListingVideo } from "@/lib/etsy/listing-video";
import { getObject, isR2Configured } from "@/lib/storage/r2";
import type { ScheduledBulkFile, ScheduledBulkUpdate } from "./bulk-job";
import { withShopAccessToken } from "./publisher";
import type { ScheduledBulkResult } from "./types";

/** What a listing's media step says when the bucket the files were stored in isn't configured. */
export const MEDIA_STORAGE_UNAVAILABLE =
  "Photos: file storage (R2) isn't set up, so the new photos and videos couldn't be uploaded. The other changes were saved.";

const message = (err: unknown) => (err instanceof Error ? err.message : "failed");

/** Whether this listing's media edit needs a stored file at all — a pure reorder doesn't. */
function needsStorage(update: ScheduledBulkUpdate): boolean {
  return (update.media?.imageFiles.length ?? 0) + (update.media?.videoFiles.length ?? 0) > 0;
}

async function readStoredFile(file: ScheduledBulkFile): Promise<Uint8Array> {
  const object = await getObject(file.key);
  if (!object) throw new Error(`${file.filename || "the file"} is missing from storage`);
  return new Uint8Array(object.body);
}

/** One listing's photo/video grid, as saved by `POST /api/etsy/listings/[id]/media`. */
async function saveMedia(shopId: number, update: ScheduledBulkUpdate): Promise<string | null> {
  const media = update.media;
  if (!media) return null;
  if (needsStorage(update) && !isR2Configured()) return MEDIA_STORAGE_UNAVAILABLE;

  const [current] = await fetchListingDetails([update.listingId]);
  if (!current) return "Photos: the listing could not be read from Etsy.";

  const images: ImagePlacement<number>[] = media.images.map((entry) =>
    entry.kind === "existing"
      ? { kind: "existing", imageId: entry.imageId, altText: entry.altText }
      : { kind: "new", item: entry.index, altText: entry.altText },
  );
  const videos: VideoPlacement<number>[] = media.videos.map((entry) =>
    entry.kind === "existing" ? { kind: "existing", videoId: entry.videoId } : { kind: "new", item: entry.index },
  );
  const plan = planListingMediaEdit({ images: current.images, videos: current.videos }, { images, videos });
  if (isEmptyMediaPlan(plan) && plan.refused.length === 0) return null;

  const result = await applyListingMediaEdit({
    shopId,
    listingId: update.listingId,
    currentImageCount: current.images.length,
    currentVideoCount: current.videos.length,
    plan,
    uploadImage: async (index, rank, altText) => {
      const file = media.imageFiles[index];
      return uploadListingImage({
        shopId,
        listingId: update.listingId,
        bytes: await readStoredFile(file),
        filename: file.filename || `photo-${index + 1}.jpg`,
        contentType: file.contentType || "image/jpeg",
        rank,
        altText: altText || undefined,
      });
    },
    uploadVideo: async (index) => {
      const file = media.videoFiles[index];
      await uploadListingVideo({
        shopId,
        listingId: update.listingId,
        bytes: await readStoredFile(file),
        filename: file.filename || "video",
        contentType: file.contentType || "application/octet-stream",
      });
    },
    imageName: (index) => media.imageFiles[index]?.filename || `Photo ${index + 1}`,
    videoName: (index) => media.videoFiles[index]?.filename || `Video ${index + 1}`,
  });
  if (result.failed.length === 0) return null;
  return `Photos: ${result.failed.map((f) => `${f.name}: ${f.error}`).join("; ")}`;
}

interface Step {
  ok: boolean;
  /** The step landed except for its variation photos (what `applyBulkUpdates` calls partial). */
  partial?: boolean;
  error?: string;
}

function merge(update: ScheduledBulkUpdate, steps: Step[]): ScheduledBulkResult {
  const failures = steps.filter((step) => !step.ok);
  const ok = failures.length === 0;
  const anythingLanded = steps.some((step) => step.ok || step.partial);
  return {
    listingId: update.listingId,
    title: update.title,
    ok,
    ...(!ok && anythingLanded ? { partial: true } : {}),
    ...(ok ? {} : { error: failures.map((f) => f.error).filter(Boolean).join("; ") || "Etsy rejected the change." }),
  };
}

/**
 * Writes the listings a claimed bulk edit still has outstanding. Resolves to
 * one result per update — it only throws when Etsy can't be reached at all
 * (no usable shop connection), which fails the whole attempt so it retries.
 */
export async function applyScheduledBulkEdit(
  row: ScheduledListing,
  updates: ScheduledBulkUpdate[],
): Promise<ScheduledBulkResult[]> {
  const shopId = Number(row.shopId);

  return withShopAccessToken(row.userId, row.shopId, async () => {
    // The listings are re-checked against this shop's cache as they are now:
    // one deleted, or moved to another shop, since the edit was scheduled is
    // reported rather than sent to Etsy.
    const owned = await listStoredListingsByIds(
      row.userId,
      row.shopId,
      updates.map((u) => u.listingId),
    );
    const ownedIds = new Set(owned.map((l) => l.listingId));

    const results: ScheduledBulkResult[] = [];
    for (const update of updates) {
      if (!ownedIds.has(update.listingId)) {
        results.push({ listingId: update.listingId, title: update.title, ok: false, error: "Listing not found." });
        continue;
      }

      const steps: Step[] = [];
      if (update.media) {
        try {
          const failure = await saveMedia(shopId, update);
          steps.push(failure ? { ok: false, error: failure } : { ok: true });
        } catch (err) {
          steps.push({ ok: false, error: `Photos: ${message(err)}` });
        }
      }

      if (Object.keys(update.patch).length > 0) {
        try {
          const [written] = await applyBulkUpdates(shopId, [
            { listingId: update.listingId, patch: update.patch },
          ]);
          steps.push({
            ok: written.ok,
            ...(written.partial ? { partial: true } : {}),
            ...(written.error ? { error: written.error } : {}),
          });
          if (written.ok || written.partial) {
            await applyStoredListingPatch(row.userId, row.shopId, update.listingId, update.patch);
          }
        } catch (err) {
          steps.push({ ok: false, error: message(err) });
        }
      }

      results.push(merge(update, steps));
    }
    return results;
  });
}
