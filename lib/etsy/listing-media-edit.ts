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
 * Photos are never deleted to reorder them. `uploadListingImage` with an
 * attached photo's `listing_image_id` and a `rank` re-ranks that photo in
 * place (same id, same file, alt text kept) — verified against a real
 * listing on 2026-09-18, though Etsy documents the parameter only for
 * re-attaching deleted photos. It *sets* that rank without moving the others,
 * so a single call can leave two photos tied; writing every photo's rank, in
 * the new order, gives exactly that order. So a save:
 *   1. uploads genuinely new photos, as the 20-photo cap allows;
 *   2. deletes only photos the user removed, never the listing's last one
 *      (Etsy refuses that), uploading any remaining new ones as room frees;
 *   3. writes rank 1…n (with alt text) for every photo, in the grid's order;
 *   4. re-reads the listing and reports any photo not where the grid put it.
 * Videos have no rank; they keep their unchanged leading run and the rest
 * are deleted and re-attached by `video_id` in slot order.
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
  /** Photos the user removed. */
  deleteImageIds: number[];
  /** Only the genuinely new photos, in grid order. */
  placeImages: Extract<ImagePlacement<NI>, { kind: "new" }>[];
  /** The whole photo grid in its final order — empty when the photos don't change. */
  imageOrder: ImagePlacement<NI>[];
  /** Kept photos whose alt text the user cleared. */
  clearAltImageIds: number[];
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

  const imagesUnchanged =
    images.length === current.images.length &&
    images.every((want, i) => {
      const have = current.images[i];
      return want.kind === "existing" && want.imageId === have.imageId && want.altText === cleanAlt(have.altText);
    });

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
    deleteImageIds: imagesUnchanged ? [] : current.images.filter((i) => !seenImages.has(i.imageId)).map((i) => i.imageId),
    placeImages: imagesUnchanged
      ? []
      : images.filter((i): i is Extract<ImagePlacement<NI>, { kind: "new" }> => i.kind === "new"),
    imageOrder: imagesUnchanged ? [] : images,
    clearAltImageIds: imagesUnchanged
      ? []
      : images.flatMap((i) =>
          i.kind === "existing" && i.altText === "" && current.images.some((c) => c.imageId === i.imageId && c.altText)
            ? [i.imageId]
            : [],
        ),
    deleteVideoIds,
    placeVideos,
    refused,
  };
}

export function isEmptyMediaPlan(plan: ListingMediaEditPlan<unknown, unknown>): boolean {
  return (
    plan.deleteImageIds.length === 0 &&
    plan.placeImages.length === 0 &&
    plan.imageOrder.length === 0 &&
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
 * Runs a plan against Etsy, sequentially — see the module comment for the
 * order of calls. Every failure is collected; one never stops the rest. The
 * listing's photos are re-read at the end (`readImages`) and any photo not at
 * the position the grid gave it, or not carrying its alt text, is reported.
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
  /** The listing's photos as Etsy has them now, in rank order. */
  readImages: () => Promise<{ imageId: number; altText: string }[]>;
}): Promise<MediaEditResult<NI>> {
  const { shopId, listingId, plan } = params;
  const failed = plan.refused.map((error) => ({ name: "Media", error }));
  const placed: PlacedImage<NI>[] = [];
  let skipped = 0;

  if (plan.imageOrder.length > 0) {
    const uploadedIds = new Map<Extract<ImagePlacement<NI>, { kind: "new" }>, number>();
    const pendingUploads = [...plan.placeImages];
    const pendingDeletes = [...plan.deleteImageIds];
    const stillAttached: number[] = [];
    let imageCount = params.currentImageCount;

    // New photos go up before any removal, so the listing never drops to zero.
    while (pendingUploads.length > 0 || pendingDeletes.length > 0) {
      if (pendingUploads.length > 0 && imageCount < MAX_LISTING_IMAGES) {
        const entry = pendingUploads.shift()!;
        const rank = plan.imageOrder.indexOf(entry) + 1;
        try {
          const img = await params.uploadImage(entry.item, rank, entry.altText);
          uploadedIds.set(entry, img.listingImageId);
          imageCount++;
        } catch (err) {
          failed.push({ name: params.imageName(entry.item), error: messageOf(err, "could not be uploaded") });
        }
      } else if (pendingDeletes.length > 0 && imageCount > 1) {
        const listingImageId = pendingDeletes.shift()!;
        try {
          await deleteListingImage({ shopId, listingId, listingImageId });
          imageCount--;
        } catch (err) {
          stillAttached.push(listingImageId);
          failed.push({ name: `Image ${listingImageId}`, error: messageOf(err, "could not be removed") });
        }
      } else {
        skipped += pendingUploads.length;
        for (const entry of pendingUploads) {
          failed.push({
            name: params.imageName(entry.item),
            error: `a listing holds at most ${MAX_LISTING_IMAGES} photos`,
          });
        }
        stillAttached.push(...pendingDeletes);
        break;
      }
    }

    // Every photo's exact rank, in the grid's order; a photo that couldn't be removed goes last.
    const finalOrder: { id: number; altText: string; name: string; item?: NI }[] = [];
    for (const entry of plan.imageOrder) {
      if (entry.kind === "existing") {
        finalOrder.push({ id: entry.imageId, altText: entry.altText, name: `Image ${entry.imageId}` });
      } else {
        const id = uploadedIds.get(entry);
        if (id != null) finalOrder.push({ id, altText: entry.altText, name: params.imageName(entry.item), item: entry.item });
      }
    }
    for (const id of stillAttached) finalOrder.push({ id, altText: "", name: `Image ${id}` });

    for (const [index, photo] of finalOrder.entries()) {
      try {
        const img = await assignListingImage({
          shopId,
          listingId,
          listingImageId: photo.id,
          rank: index + 1,
          altText: photo.altText || (plan.clearAltImageIds.includes(photo.id) ? "" : undefined),
        });
        placed.push({
          name: photo.name,
          rank: index + 1,
          listingImageId: photo.id,
          url: img.url,
          ...(photo.item !== undefined ? { item: photo.item } : {}),
        });
      } catch (err) {
        failed.push({ name: photo.name, error: messageOf(err, "could not be moved into place") });
      }
    }

    const wanted = finalOrder.slice(0, finalOrder.length - stillAttached.length);
    try {
      const onEtsy = await params.readImages();
      const wrong = wanted.filter(
        (photo, i) =>
          onEtsy[i]?.imageId !== photo.id ||
          ((photo.altText !== "" || plan.clearAltImageIds.includes(photo.id)) &&
            cleanAlt(onEtsy[i].altText ?? "") !== photo.altText),
      );
      if (wrong.length > 0) {
        failed.push({
          name: "Photo order",
          error: `Etsy doesn't show ${wrong.map((p) => `${p.name} at position ${finalOrder.indexOf(p) + 1}`).join(", ")} as the editor has it.`,
        });
      }
    } catch (err) {
      failed.push({ name: "Photo order", error: `couldn't be checked on Etsy: ${messageOf(err, "read failed")}` });
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
