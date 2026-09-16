import { MAX_LISTING_IMAGES, checkImageFileBasics } from "@/lib/etsy/listing-image-limits";
import { MAX_LISTING_VIDEOS } from "@/lib/etsy/video-limits";
import type { ListingVideoItem, PhotoSlot } from "./ListingMedia";
import { moveItem, slotIdFor, withAltText, type ImageSlotRef } from "./photo-order";

/**
 * The tile-grid state for one listing that already exists on Etsy, as the bulk
 * screen edits it: the listing's own photos and videos plus anything added in
 * this session. Pure — every edit returns a new state and none of them talks
 * to Etsy; `mediaSaveForm` is what an explicit save sends.
 */

export interface EtsyListingMedia {
  images: { imageId: number; url: string; rank: number; altText: string }[];
  videos: { videoId: number; thumbnailUrl: string; videoUrl: string; state: string }[];
}

export interface AddedPhoto {
  id: string;
  file: File;
  url: string;
}

export interface ExistingMediaState {
  order: ImageSlotRef[];
  altTextBySlot: Record<string, string>;
  added: AddedPhoto[];
  videos: (ListingVideoItem | null)[];
  videoErrors: (string | null)[];
}

export function initialExistingMedia(media: EtsyListingMedia): ExistingMediaState {
  const images = [...media.images].sort((a, b) => a.rank - b.rank);
  const videos: (ListingVideoItem | null)[] = media.videos
    .slice(0, MAX_LISTING_VIDEOS)
    .map((v) => ({ kind: "etsy", videoId: v.videoId, videoUrl: v.videoUrl, thumbnailUrl: v.thumbnailUrl }));
  while (videos.length < MAX_LISTING_VIDEOS) videos.push(null);
  return {
    order: images.map((img) => ({ kind: "etsy", imageId: img.imageId })),
    altTextBySlot: Object.fromEntries(images.map((img) => [`etsy:${img.imageId}`, img.altText])),
    added: [],
    videos,
    videoErrors: videos.map(() => null),
  };
}

export function mediaPhotoSlots(state: ExistingMediaState, media: EtsyListingMedia): PhotoSlot[] {
  return state.order.map((ref) => {
    const slotId = slotIdFor(ref);
    if (ref.kind === "etsy") {
      const img = media.images.find((i) => i.imageId === ref.imageId);
      return { slotId, ref, thumbnailUrl: img?.url ?? null, label: `Etsy photo ${img?.rank ?? ""}`.trim() };
    }
    const added = ref.kind === "own" ? state.added.find((a) => a.id === ref.id) : undefined;
    return { slotId, ref, thumbnailUrl: added?.url ?? null, label: added?.file.name ?? "Photo" };
  });
}

export function moveMediaPhoto(state: ExistingMediaState, from: number, to: number): ExistingMediaState {
  const order = moveItem(state.order, from, to);
  return order === state.order ? state : { ...state, order };
}

/** The state without that tile, and the added photo it held (so its object URL can be revoked). */
export function removeMediaPhoto(
  state: ExistingMediaState,
  slotId: string,
): { state: ExistingMediaState; removed: AddedPhoto | null } {
  const ref = state.order.find((r) => slotIdFor(r) === slotId);
  if (!ref) return { state, removed: null };
  const removed = ref.kind === "own" ? (state.added.find((a) => a.id === ref.id) ?? null) : null;
  const altTextBySlot = { ...state.altTextBySlot };
  delete altTextBySlot[slotId];
  return {
    state: {
      ...state,
      order: state.order.filter((r) => slotIdFor(r) !== slotId),
      added: removed ? state.added.filter((a) => a !== removed) : state.added,
      altTextBySlot,
    },
    removed,
  };
}

/**
 * Adds picked files as new tiles at the end. Files Etsy would refuse, or past
 * the `MAX_LISTING_IMAGES` slots, are left out and reported.
 */
export function addMediaPhotos(
  state: ExistingMediaState,
  files: File[],
  makePhoto: (file: File) => AddedPhoto,
): { state: ExistingMediaState; errors: string[] } {
  const errors: string[] = [];
  const added: AddedPhoto[] = [];
  for (const file of files) {
    const error = checkImageFileBasics(file);
    if (error) {
      errors.push(`${file.name}: ${error}`);
      continue;
    }
    if (state.order.length + added.length >= MAX_LISTING_IMAGES) {
      errors.push(`${file.name}: a listing holds at most ${MAX_LISTING_IMAGES} photos.`);
      continue;
    }
    added.push(makePhoto(file));
  }
  if (added.length === 0) return { state, errors };
  return {
    state: {
      ...state,
      added: [...state.added, ...added],
      order: [...state.order, ...added.map((a): ImageSlotRef => ({ kind: "own", id: a.id }))],
    },
    errors,
  };
}

export function setMediaAltText(state: ExistingMediaState, slotId: string, text: string): ExistingMediaState {
  return { ...state, altTextBySlot: withAltText(state.altTextBySlot, slotId, text) };
}

export function setMediaVideo(
  state: ExistingMediaState,
  slot: number,
  file: File | null,
  error: string | null = null,
): ExistingMediaState {
  return {
    ...state,
    videos: error ? state.videos : state.videos.map((v, i) => (i === slot ? (file ? { kind: "file", file } : null) : v)),
    videoErrors: state.videoErrors.map((e, i) => (i === slot ? error : e)),
  };
}

export function moveMediaVideo(state: ExistingMediaState, from: number, to: number): ExistingMediaState {
  return {
    ...state,
    videos: moveItem(state.videos, from, to),
    videoErrors: moveItem(state.videoErrors, from, to),
  };
}

type ImageEntry =
  | { kind: "existing"; imageId: number; altText: string }
  | { kind: "new"; index: number; altText: string };
type VideoEntry = { kind: "existing"; videoId: number } | { kind: "new"; index: number };

/** The `{ images, videos }` order `POST /api/etsy/listings/[id]/media` takes, plus the files it addresses. */
export function mediaSavePayload(state: ExistingMediaState): {
  payload: { images: ImageEntry[]; videos: VideoEntry[] };
  imageFiles: File[];
  videoFiles: File[];
} {
  const imageFiles: File[] = [];
  const images: ImageEntry[] = [];
  for (const ref of state.order) {
    const altText = state.altTextBySlot[slotIdFor(ref)] ?? "";
    if (ref.kind === "etsy") {
      images.push({ kind: "existing", imageId: ref.imageId, altText });
    } else if (ref.kind === "own") {
      const added = state.added.find((a) => a.id === ref.id);
      if (!added) continue;
      images.push({ kind: "new", index: imageFiles.length, altText });
      imageFiles.push(added.file);
    }
  }
  const videoFiles: File[] = [];
  const videos: VideoEntry[] = [];
  for (const video of state.videos) {
    if (!video) continue;
    if (video.kind === "etsy") {
      videos.push({ kind: "existing", videoId: video.videoId });
    } else {
      videos.push({ kind: "new", index: videoFiles.length });
      videoFiles.push(video.file);
    }
  }
  return { payload: { images, videos }, imageFiles, videoFiles };
}

/** Would saving this state change anything on the listing? */
export function mediaChanged(state: ExistingMediaState, media: EtsyListingMedia): boolean {
  const current = mediaSavePayload(state);
  const original = mediaSavePayload(initialExistingMedia(media));
  return JSON.stringify(current.payload) !== JSON.stringify(original.payload);
}

export function mediaSaveForm(state: ExistingMediaState): FormData {
  const { payload, imageFiles, videoFiles } = mediaSavePayload(state);
  const form = new FormData();
  form.set("payload", JSON.stringify(payload));
  for (const file of imageFiles) form.append("image", file);
  for (const file of videoFiles) form.append("video", file);
  return form;
}
