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
