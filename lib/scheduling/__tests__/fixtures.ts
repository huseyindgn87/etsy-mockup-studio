/** Shared test data for the scheduling tests. */

import { renderImageKey } from "../render-keys";
import type { ScheduledImage } from "../types";

export const SET_A = "11111111-1111-4111-8111-111111111111";
export const SET_B = "22222222-2222-4222-8222-222222222222";

/** A valid "new listing" publish spec, as the editor sends it. */
export const VALID_SPEC = {
  mode: "new",
  howItsMade: { whoMade: "i_did", isSupply: false, whenMade: "made_to_order", productionPartnerIds: [] },
  newListing: {
    title: "Halloween mug",
    description: "A spooky mug.",
    tags: ["mug", "halloween"],
    taxonomyId: 1234,
    readinessStateId: 55,
    price: 12.5,
    quantity: 3,
    properties: [],
    shouldAutoRenew: true,
  },
};

/** What the editor sends for `n` uploaded images. */
export function imageMeta(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    filename: `mug-${i + 1}.jpg`,
    contentType: "image/jpeg",
    altText: `View ${i + 1}`,
  }));
}

/** The stored `images` column for `n` images in `renderSetId`. */
export function storedImages(userId: string, n: number, renderSetId = SET_A): ScheduledImage[] {
  return Array.from({ length: n }, (_, i) => ({
    key: renderImageKey(userId, renderSetId, i),
    filename: `mug-${i + 1}.jpg`,
    contentType: "image/jpeg",
    altText: `View ${i + 1}`,
  }));
}
