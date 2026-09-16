import { MAX_ALT_TEXT_LENGTH, MAX_LISTING_IMAGES } from "@/lib/etsy/listing-image-limits";
import {
  assignListingImage,
  deleteListingImage,
  type UploadedListingImage,
} from "@/lib/etsy/listing-images";
import { assignListingVideo, deleteListingVideo } from "@/lib/etsy/listing-video";
import { MAX_LISTING_VIDEOS } from "@/lib/etsy/video-limits";

/**
 * Saving an edited photo/video grid onto a listing that already exists on
 * Etsy — reorder, remove, alt text and new files, all at once.
 *
 * Etsy's Open API has no "reorder" or "edit alt text" call for listing
 * images. What it does document is that a deleted image stays on Etsy's
 * servers and can be re-associated with the listing by `listing_image_id`,
 * at a chosen `rank` and with `alt_text` (`uploadListingImage`), and the same
 * for videos by `video_id` (`uploadListingVideo`). So a save keeps the
 * longest unchanged run of leading images exactly as they are, removes every
 * image after it, and places the rest back in the new order — removed tiles
 * simply aren't placed back.
 *
 * Only ever called from an explicit save (the editor's Publish, the bulk
 * screen's Sync updates); nothing here runs while tiles are being edited.
 */

export type ImagePlacement<N> =
  | { kind: "existing"; imageId: number; altText: string }
  | { kind: "new"; item: N; altText: string };

export type VideoPlacement<N> = { kind: "existing"; videoId: number } | { kind: "new"; item: N };

export interface CurrentListingMedia {
  /** In Etsy's rank order. */
  images: { imageId: number; altText: string }[];
  videos: { videoId: number }[];
}

export interface ListingMediaEditPlan<NI, NV> {
  deleteImageIds: number[];
  placeImages: ImagePlacement<NI>[];
  deleteVideoIds: number[];
  placeVideos: VideoPlacement<NV>[];
  /** Asked-for entries that were refused before any call was planned. */
  refused: string[];
}

const cleanAlt = (text: string) => text.slice(0, MAX_ALT_TEXT_LENGTH);

/**
 * The calls that turn `current` into `desired`. An existing id that isn't on
 * this listing (or appears twice) is refused rather than re-associated, so a
 * save can only ever rearrange this listing's own media. `desired.videos`
 * null leaves the listing's videos alone.
 */
export function planListingMediaEdit<NI, NV>(
  current: CurrentListingMedia,
  desired: { images: ImagePlacement<NI>[]; videos: VideoPlacement<NV>[] | null },
): ListingMediaEditPlan<NI, NV> {
  const refused: string[] = [];

  const currentImageIds = new Set(current.images.map((i) => i.imageId));
  const seenImages = new Set<number>();
  const images: ImagePlacement<NI>[] = [];
  for (const entry of desired.images) {
    if (entry.kind === "existing") {
      if (!currentImageIds.has(entry.imageId) || seenImages.has(entry.imageId)) {
        refused.push(`Image ${entry.imageId} is not on this listing.`);
        continue;
      }
      seenImages.add(entry.imageId);
    }
    images.push({ ...entry, altText: cleanAlt(entry.altText) });
  }

  let keep = 0;
  while (keep < images.length && keep < current.images.length) {
    const want = images[keep];
    const have = current.images[keep];
    if (want.kind !== "existing" || want.imageId !== have.imageId || want.altText !== cleanAlt(have.altText)) break;
    keep++;
  }
  const imagesUnchanged = keep === images.length && keep === current.images.length;

  let deleteVideoIds: number[] = [];
  let placeVideos: VideoPlacement<NV>[] = [];
  if (desired.videos) {
    const currentVideoIds = new Set(current.videos.map((v) => v.videoId));
    const seenVideos = new Set<number>();
    const videos: VideoPlacement<NV>[] = [];
    for (const entry of desired.videos) {
      if (entry.kind === "existing") {
        if (!currentVideoIds.has(entry.videoId) || seenVideos.has(entry.videoId)) {
          refused.push(`Video ${entry.videoId} is not on this listing.`);
          continue;
        }
        seenVideos.add(entry.videoId);
      }
      videos.push(entry);
    }
    let keepVideos = 0;
    while (
      keepVideos < videos.length &&
      keepVideos < current.videos.length &&
      videos[keepVideos].kind === "existing" &&
      (videos[keepVideos] as { videoId: number }).videoId === current.videos[keepVideos].videoId
    ) {
      keepVideos++;
    }
    deleteVideoIds = current.videos.slice(keepVideos).map((v) => v.videoId);
    placeVideos = videos.slice(keepVideos);
  }

  return {
    deleteImageIds: imagesUnchanged ? [] : current.images.slice(keep).map((i) => i.imageId),
    placeImages: imagesUnchanged ? [] : images.slice(keep),
    deleteVideoIds,
    placeVideos,
    refused,
  };
}

export function isEmptyMediaPlan(plan: ListingMediaEditPlan<unknown, unknown>): boolean {
  return (
    plan.deleteImageIds.length === 0 &&
    plan.placeImages.length === 0 &&
    plan.deleteVideoIds.length === 0 &&
    plan.placeVideos.length === 0
  );
}

export interface PlacedImage<N> {
  name: string;
  rank: number;
  listingImageId: number;
  url: string | null;
  item?: N;
}

export interface MediaEditResult<NI> {
  /** Every image placed by this save — re-associated or newly uploaded — in rank order. */
  placed: PlacedImage<NI>[];
  failed: { name: string; error: string }[];
  skipped: number;
}

const messageOf = (err: unknown, fallback: string) => (err instanceof Error ? err.message : fallback);

/**
 * Runs a plan against Etsy, sequentially. A failed delete leaves that image
 * where it is (and it is not placed again); a failed placement is reported
 * and the next one takes its rank, so ranks never gap. Every failure is
 * collected — one never stops the rest.
 */
export async function applyListingMediaEdit<NI, NV>(params: {
  shopId: number;
  listingId: number;
  currentImageCount: number;
  currentVideoCount: number;
  plan: ListingMediaEditPlan<NI, NV>;
  uploadImage: (item: NI, rank: number, altText: string) => Promise<UploadedListingImage>;
  uploadVideo: (item: NV) => Promise<void>;
  imageName: (item: NI) => string;
  videoName: (item: NV) => string;
}): Promise<MediaEditResult<NI>> {
  const { shopId, listingId, plan } = params;
  const failed = plan.refused.map((error) => ({ name: "Media", error }));
  const placed: PlacedImage<NI>[] = [];
  let skipped = 0;

  let imageCount = params.currentImageCount;
  const stillAttached = new Set<number>();
  for (const listingImageId of plan.deleteImageIds) {
    try {
      await deleteListingImage({ shopId, listingId, listingImageId });
      imageCount--;
    } catch (err) {
      stillAttached.add(listingImageId);
      failed.push({ name: `Image ${listingImageId}`, error: messageOf(err, "could not be removed") });
    }
  }

  for (const entry of plan.placeImages) {
    if (entry.kind === "existing" && stillAttached.has(entry.imageId)) continue;
    if (imageCount >= MAX_LISTING_IMAGES) {
      skipped++;
      continue;
    }
    const rank = imageCount + 1;
    const name = entry.kind === "existing" ? `Image ${entry.imageId}` : params.imageName(entry.item);
    try {
      const img =
        entry.kind === "existing"
          ? await assignListingImage({
              shopId,
              listingId,
              listingImageId: entry.imageId,
              rank,
              altText: entry.altText || undefined,
            })
          : await params.uploadImage(entry.item, rank, entry.altText);
      imageCount++;
      placed.push({
        name,
        rank: img.rank ?? rank,
        listingImageId: img.listingImageId,
        url: img.url,
        ...(entry.kind === "new" ? { item: entry.item } : {}),
      });
    } catch (err) {
      failed.push({ name, error: messageOf(err, "could not be saved") });
    }
  }

  let videoCount = params.currentVideoCount;
  const videosStillAttached = new Set<number>();
  for (const videoId of plan.deleteVideoIds) {
    try {
      await deleteListingVideo({ shopId, listingId, videoId });
      videoCount--;
    } catch (err) {
      videosStillAttached.add(videoId);
      failed.push({ name: `Video ${videoId}`, error: messageOf(err, "could not be removed") });
    }
  }
  for (const entry of plan.placeVideos) {
    if (entry.kind === "existing" && videosStillAttached.has(entry.videoId)) continue;
    if (videoCount >= MAX_LISTING_VIDEOS) {
      skipped++;
      continue;
    }
    const name = entry.kind === "existing" ? `Video ${entry.videoId}` : params.videoName(entry.item);
    try {
      if (entry.kind === "existing") await assignListingVideo({ shopId, listingId, videoId: entry.videoId });
      else await params.uploadVideo(entry.item);
      videoCount++;
    } catch (err) {
      failed.push({ name, error: messageOf(err, "could not be saved") });
    }
  }

  return { placed, failed, skipped };
}

/** Reads the client's `{ images, videos }` media order, with new entries addressed by file index. */
export function parseMediaOrder(
  raw: unknown,
  newImageCount: number,
  newVideoCount: number,
): { images: ImagePlacement<number>[]; videos: VideoPlacement<number>[] | null } {
  const r = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const isIndex = (v: unknown, count: number): v is number =>
    typeof v === "number" && Number.isInteger(v) && v >= 0 && v < count;
  const isId = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v > 0;

  const images: ImagePlacement<number>[] = [];
  for (const e of Array.isArray(r.images) ? r.images : []) {
    if (!e || typeof e !== "object") continue;
    const entry = e as Record<string, unknown>;
    const altText = typeof entry.altText === "string" ? entry.altText : "";
    if (entry.kind === "existing" && isId(entry.imageId)) {
      images.push({ kind: "existing", imageId: entry.imageId, altText });
    } else if (entry.kind === "new" && isIndex(entry.index, newImageCount)) {
      images.push({ kind: "new", item: entry.index, altText });
    }
  }

  if (!Array.isArray(r.videos)) return { images, videos: null };
  const videos: VideoPlacement<number>[] = [];
  for (const e of r.videos) {
    if (!e || typeof e !== "object") continue;
    const entry = e as Record<string, unknown>;
    if (entry.kind === "existing" && isId(entry.videoId)) {
      videos.push({ kind: "existing", videoId: entry.videoId });
    } else if (entry.kind === "new" && isIndex(entry.index, newVideoCount)) {
      videos.push({ kind: "new", item: entry.index });
    }
  }
  return { images, videos };
}
