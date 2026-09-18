/**
 * Publishes one claimed scheduled listing to Etsy, for the runner
 * (lib/scheduling/runner.ts). Server-only.
 *
 * Sends only what was fixed at schedule time — the stored listing content
 * and the images already rendered and uploaded to R2. Nothing is composited
 * here. Every step is safe to repeat on a retry: the listing is created once
 * (its id is recorded straight away), follow-up details are full replaces,
 * and images are uploaded with `overwrite` at their fixed ranks.
 *
 * There's no browser session in a runner, so Etsy is called with a fresh
 * access token from the shop connection's stored (encrypted) refresh token.
 */

import type { ScheduledListing } from "@prisma/client";
import { withEtsyAccessToken } from "@/lib/etsy/auth";
import { withEtsyContext } from "@/lib/etsy/client";
import { activateListing, createDraftListing, updateVariationImages } from "@/lib/etsy/listing-create";
import { uploadListingImage } from "@/lib/etsy/listing-images";
import { refreshSession } from "@/lib/etsy/oauth";
import { applyListingDetails, resolveDraftListingInput } from "@/lib/etsy/publish-listing";
import { getDecryptedRefreshToken, updateConnectionRefreshToken } from "@/lib/etsy/shop-connections";
import { getObject } from "@/lib/storage/r2";
import { coerceScheduledImages, parseScheduledPublishSpec } from "./publish-spec";
import type { PublishHooks } from "./runner";

/** Runs `fn` authenticated as the user's stored connection to `shopId`, persisting Etsy's rotated refresh token. */
export async function withShopAccessToken<T>(userId: string, shopId: string, fn: () => Promise<T>): Promise<T> {
  const refreshToken = await getDecryptedRefreshToken(userId, shopId);
  if (!refreshToken) {
    throw new Error("This Etsy shop is no longer connected. Reconnect it, then reschedule the listing.");
  }
  const tokens = await withEtsyContext({ userId }, () => refreshSession(refreshToken));
  await updateConnectionRefreshToken(userId, shopId, tokens.refreshToken);
  return withEtsyAccessToken(tokens.accessToken, fn, { userId, priority: "background" });
}

const message = (err: unknown) => (err instanceof Error ? err.message : "failed");

export async function publishScheduledListing(row: ScheduledListing, hooks: PublishHooks): Promise<string> {
  const parsed = parseScheduledPublishSpec(row.publishSpec);
  if (!parsed.ok) throw new Error(`The scheduled listing's details are invalid: ${parsed.error}`);
  const images = coerceScheduledImages(row.images);
  if (images.length === 0) throw new Error("The scheduled listing has no images to publish.");
  const shopId = Number(row.shopId);

  return withShopAccessToken(row.userId, row.shopId, async () => {
    const resolved = await resolveDraftListingInput(parsed.plan);

    let listingId = row.etsyListingId ? Number(row.etsyListingId) : null;
    if (!listingId) {
      listingId = await createDraftListing(shopId, resolved.input);
      await hooks.onListingCreated(String(listingId));
    }

    // Unlike the editor's Publish, any failed step fails the attempt: the
    // listing is about to go live, so it must never go live half set up.
    const variations = await applyListingDetails(shopId, listingId, parsed.plan, resolved, (step, err) => {
      throw new Error(`${step}: ${message(err)}`);
    });

    const imageIds: number[] = [];
    for (let i = 0; i < images.length; i++) {
      const image = images[i];
      const object = await getObject(image.key);
      if (!object) throw new Error(`Image ${i + 1} is missing from storage.`);
      try {
        const uploaded = await uploadListingImage({
          shopId,
          listingId,
          bytes: new Uint8Array(object.body),
          filename: image.filename,
          contentType: image.contentType,
          rank: i + 1,
          overwrite: true,
          altText: image.altText,
        });
        imageIds.push(uploaded.listingImageId);
      } catch (err) {
        throw new Error(`Image ${i + 1}: ${message(err)}`);
      }
    }

    // The stored images are the photo grid in order, so `imageIndex` is their position.
    const variationImages = (variations?.imagesByValue ?? []).flatMap((v) =>
      v.imageIndex != null && imageIds[v.imageIndex] != null
        ? [{ propertyId: v.propertyId, valueId: v.valueId, imageId: imageIds[v.imageIndex] }]
        : [],
    );
    if (variationImages.length > 0) {
      try {
        await updateVariationImages(shopId, listingId, variationImages);
      } catch (err) {
        throw new Error(`Variation photos: ${message(err)}`);
      }
    }

    await activateListing(shopId, listingId);
    return String(listingId);
  });
}
