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
 * Deletes images a schedule no longer references (replaced by a re-render).
 * Only keys under the old set's own prefix; best-effort.
 */
export async function deleteSupersededImages(
  userId: string,
  superseded: { renderSetId: string | null; images: ScheduledImage[] },
): Promise<void> {
  if (!isR2Configured()) return;
  const keys = superseded.images
    .map((image) => image.key)
    .filter((key) => isOwnedRenderKey(key, userId, superseded.renderSetId));
  await deleteObjects(keys).catch((err) => {
    console.error("[schedule] couldn't delete superseded images", err);
  });
}
