/**
 * Storage checks around a schedule's images. Server-only — talks to R2.
 */

import { deleteObjects, isR2Configured, listKeys } from "@/lib/storage/r2";
import { isOwnedRenderKey, renderSetPrefix } from "./render-keys";
import type { ScheduledImage } from "./types";

/** The images not (yet) in storage — a schedule is only created once this is empty. */
export async function missingImages(
  userId: string,
  renderSetId: string,
  images: ScheduledImage[],
): Promise<ScheduledImage[]> {
  const present = new Set(await listKeys(renderSetPrefix(userId, renderSetId)));
  return images.filter((image) => !present.has(image.key));
}

/**
 * Deletes images nothing references any more — a schedule that was cancelled,
 * or renders replaced by a re-render. Only keys under that set's own
 * `scheduled/{userId}/{renderSetId}/` prefix are touched, so this can never
 * reach a user's own uploads. Best-effort: a storage failure is logged, not
 * thrown, since the row has already changed.
 */
export async function deleteScheduledImages(
  userId: string,
  released: { renderSetId: string | null; images: ScheduledImage[] },
): Promise<void> {
  if (!isR2Configured()) return;
  const keys = released.images
    .map((image) => image.key)
    .filter((key) => isOwnedRenderKey(key, userId, released.renderSetId));
  if (keys.length === 0) return;
  await deleteObjects(keys).catch((err) => {
    console.error("[schedule] couldn't delete rendered images", err);
  });
}
