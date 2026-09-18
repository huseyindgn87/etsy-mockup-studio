/**
 * What counts as a change to a listing — one definition shared by the single
 * editor's Sync to Etsy, bulk edit's Sync updates and Schedule, the draft
 * autosave and the unsaved-changes warning: two states are the same only when
 * every value in them is deep-equal (object key order aside). Nothing is
 * exempt; a difference that can't be written to Etsy is reported as an
 * {@link UnsyncedChange}, never dropped.
 */

import type { ImageSlotRef } from "@/app/components/listing-media/photo-order";
import { draftSnapshotKey } from "@/lib/drafts/snapshot";

export const sameState = (a: unknown, b: unknown): boolean => draftSnapshotKey(a) === draftSnapshotKey(b);

/** Every key whose value differs between the two, over the keys of both. */
export function changedKeys<T extends object>(original: T, current: T): (keyof T)[] {
  const keys = new Set([...Object.keys(original), ...Object.keys(current)] as (keyof T)[]);
  return [...keys].filter((key) => !sameState(original[key], current[key]));
}

/** A change the user made that Etsy's API can't write, and why. */
export interface UnsyncedChange {
  field: string;
  reason: string;
}

/** "Not synced to Etsy: Feature listing (…); Promote with Etsy Ads (…)." */
export function describeUnsynced(unsynced: UnsyncedChange[]): string {
  return `Not synced to Etsy: ${unsynced.map((u) => `${u.field} (${u.reason})`).join("; ")}.`;
}

/** A photo/video grid reduced to what reaches Etsy: photo order with alt text, and video order. */
export interface MediaState {
  images: { slot: string; altText: string }[];
  videos: string[];
}

export interface EtsyMediaLike {
  images: { imageId: number; rank: number; altText: string }[];
  videos: { videoId: number }[];
}

export function mediaStateFromEtsy(media: EtsyMediaLike): MediaState {
  return {
    images: [...media.images]
      .sort((a, b) => a.rank - b.rank)
      .map((img) => ({ slot: `etsy:${img.imageId}`, altText: img.altText ?? "" })),
    videos: media.videos.map((v) => `etsy:${v.videoId}`),
  };
}

type VideoLike = { kind: "etsy"; videoId: number } | { kind: "file"; id?: string; file: File };

export function mediaStateFromGrid(
  order: ImageSlotRef[],
  altTextBySlot: Record<string, string>,
  videos: (VideoLike | null)[],
  slotIdFor: (ref: ImageSlotRef) => string,
): MediaState {
  const fileKeys = new Map<File, string>();
  return {
    images: order.map((ref) => {
      const slot = slotIdFor(ref);
      return { slot, altText: altTextBySlot[slot] ?? "" };
    }),
    videos: videos.flatMap((v, i) => {
      if (!v) return [];
      if (v.kind === "etsy") return [`etsy:${v.videoId}`];
      if (!fileKeys.has(v.file)) fileKeys.set(v.file, `file:${v.id ?? i}`);
      return [fileKeys.get(v.file)!];
    }),
  };
}

/** Which parts of a grid differ from the listing's media as Etsy has it. */
export function mediaChanges(original: MediaState, current: MediaState): { photos: boolean; videos: boolean } {
  return {
    photos: !sameState(original.images, current.images),
    videos: !sameState(original.videos, current.videos),
  };
}
