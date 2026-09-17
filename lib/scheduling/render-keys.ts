/**
 * R2 object keys for a scheduled listing's images — the browser-rendered
 * mockups and copies of the user's own photos, uploaded when the listing is
 * scheduled. Dependency-free, so the upload route, the store, the runner's
 * cleanup and the tests share one definition.
 *
 * Every key is `scheduled/{userId}/{renderSetId}/image-NN`. That prefix is
 * what marks an object as belonging to a scheduled job: it's disjoint from
 * everything the user uploads themselves (`drafts/…`, `templates/user/…`,
 * see lib/storage/r2.ts), and {@link isOwnedRenderKey} is checked before any
 * delete, so cleanup can never reach a user upload.
 */

import { MAX_LISTING_IMAGES } from "@/lib/etsy/listing-image-limits";
import { MAX_LISTING_VIDEOS } from "@/lib/etsy/video-limits";

export const SCHEDULED_RENDERS_ROOT = "scheduled/";

/** A render set id is a browser `crypto.randomUUID()`. */
const RENDER_SET_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const IMAGE_SLOT_RE = /^image-(\d{2})$/;
/** App user ids are cuids — anything else never becomes part of a key. */
const USER_ID_RE = /^[a-z0-9]{1,64}$/i;

export function isRenderSetId(value: unknown): value is string {
  return typeof value === "string" && RENDER_SET_ID_RE.test(value);
}

/** `image-00` … `image-19`: the slot name for the image at position `index`. */
export function imageSlot(index: number): string {
  return `image-${String(index).padStart(2, "0")}`;
}

/** The position an `image-NN` slot name stands for, or `null` when it isn't one within the listing limit. */
export function slotIndex(slot: unknown): number | null {
  if (typeof slot !== "string") return null;
  const m = IMAGE_SLOT_RE.exec(slot);
  if (!m) return null;
  const index = Number(m[1]);
  return index < MAX_LISTING_IMAGES ? index : null;
}

export function renderSetPrefix(userId: string, renderSetId: string): string {
  if (!USER_ID_RE.test(userId) || !isRenderSetId(renderSetId)) {
    throw new Error("Invalid user or render set id for a scheduled render key.");
  }
  return `${SCHEDULED_RENDERS_ROOT}${userId}/${renderSetId}/`;
}

export function renderImageKey(userId: string, renderSetId: string, index: number): string {
  return `${renderSetPrefix(userId, renderSetId)}${imageSlot(index)}`;
}

/**
 * True only for a key that is exactly `scheduled/{userId}/{renderSetId}/image-NN`
 * — the guard every delete of scheduled images goes through.
 */
export function isOwnedRenderKey(key: unknown, userId: string, renderSetId: string | null): boolean {
  if (typeof key !== "string" || !renderSetId || !isRenderSetId(renderSetId) || !USER_ID_RE.test(userId)) {
    return false;
  }
  const prefix = `${SCHEDULED_RENDERS_ROOT}${userId}/${renderSetId}/`;
  return key.startsWith(prefix) && slotIndex(key.slice(prefix.length)) !== null;
}

/**
 * Slot names for the files a **scheduled bulk edit** stores: a photo or video
 * the user added to a row's media grid, kept under the same
 * `scheduled/{userId}/{setId}/` prefix as a publish job's renders, but named
 * per listing — `media-{listingId}-image-NN` / `media-{listingId}-video-NN`.
 */
const BULK_MEDIA_SLOT_RE = /^media-(\d{1,16})-(image|video)-(\d{2})$/;

export type BulkMediaKind = "image" | "video";

export interface BulkMediaSlot {
  listingId: number;
  kind: BulkMediaKind;
  index: number;
}

export function bulkMediaSlot(listingId: number, kind: BulkMediaKind, index: number): string {
  if (!Number.isInteger(listingId) || listingId <= 0) {
    throw new Error("Invalid listing id for a scheduled media key.");
  }
  return `media-${listingId}-${kind}-${String(index).padStart(2, "0")}`;
}

/** The listing, kind and position a bulk-media slot name stands for, or `null` when it isn't one. */
export function parseBulkMediaSlot(slot: unknown): BulkMediaSlot | null {
  if (typeof slot !== "string") return null;
  const m = BULK_MEDIA_SLOT_RE.exec(slot);
  if (!m) return null;
  const listingId = Number(m[1]);
  const kind = m[2] as BulkMediaKind;
  const index = Number(m[3]);
  if (!Number.isSafeInteger(listingId) || listingId <= 0) return null;
  if (index >= (kind === "image" ? MAX_LISTING_IMAGES : MAX_LISTING_VIDEOS)) return null;
  return { listingId, kind, index };
}

export function bulkMediaKey(
  userId: string,
  setId: string,
  listingId: number,
  kind: BulkMediaKind,
  index: number,
): string {
  return `${renderSetPrefix(userId, setId)}${bulkMediaSlot(listingId, kind, index)}`;
}

/**
 * True for any key a scheduled job of either kind owns — a publish job's
 * `image-NN` render or a bulk edit's `media-…` file. The guard every delete
 * of a job's stored files goes through, so cleanup can never reach a user
 * upload under `drafts/` or `templates/user/`.
 */
export function isOwnedScheduleKey(key: unknown, userId: string, setId: string | null): boolean {
  if (isOwnedRenderKey(key, userId, setId)) return true;
  if (typeof key !== "string" || !setId || !isRenderSetId(setId) || !USER_ID_RE.test(userId)) return false;
  const prefix = `${SCHEDULED_RENDERS_ROOT}${userId}/${setId}/`;
  return key.startsWith(prefix) && parseBulkMediaSlot(key.slice(prefix.length)) !== null;
}
