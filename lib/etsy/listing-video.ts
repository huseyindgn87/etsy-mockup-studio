import { etsyFetch } from "@/lib/etsy/auth";
import { readEtsyResponse } from "@/lib/etsy/listings";

/**
 * Upload a video to an Etsy listing (API v3).
 *
 * `POST /v3/application/shops/{shop_id}/listings/{listing_id}/videos` —
 * multipart/form-data, `listings_w` scope. Etsy allows up to
 * `MAX_LISTING_VIDEOS` videos per listing (see `video-limits.ts`); callers
 * upload each one with its own call.
 */

export interface UploadedListingVideo {
  videoId: number;
  videoUrl: string | null;
  thumbnailUrl: string | null;
}

interface RawListingVideo {
  video_id: number;
  video_url?: string;
  thumbnail_url?: string;
}

export async function uploadListingVideo(params: {
  shopId: number;
  listingId: number;
  bytes: Uint8Array;
  filename: string;
  contentType: string;
}): Promise<UploadedListingVideo> {
  const form = new FormData();
  form.append(
    "video",
    // copy into a fresh, non-shared buffer so it is a valid BlobPart
    new Blob([new Uint8Array(params.bytes)], { type: params.contentType }),
    params.filename,
  );
  form.append("name", params.filename);

  const res = await etsyFetch(`/shops/${params.shopId}/listings/${params.listingId}/videos`, {
    method: "POST",
    body: form,
  });
  const raw = (await readEtsyResponse(
    res,
    `POST /shops/${params.shopId}/listings/${params.listingId}/videos`,
    { filename: params.filename, contentType: params.contentType, bytes: params.bytes.length },
  )) as RawListingVideo;
  return {
    videoId: raw.video_id,
    videoUrl: raw.video_url ?? null,
    thumbnailUrl: raw.thumbnail_url ?? null,
  };
}

/**
 * Associate a video this shop already has with the listing again — the same
 * `POST .../videos` call with `video_id` instead of a file.
 */
export async function assignListingVideo(params: {
  shopId: number;
  listingId: number;
  videoId: number;
}): Promise<void> {
  const form = new FormData();
  form.append("video_id", String(Math.trunc(params.videoId)));
  const path = `/shops/${params.shopId}/listings/${params.listingId}/videos`;
  await readEtsyResponse(await etsyFetch(path, { method: "POST", body: form }), `POST ${path}`, {
    videoId: params.videoId,
  });
}

/**
 * `DELETE /v3/application/shops/{shop_id}/listings/{listing_id}/videos/{video_id}`
 * — `listings_w` scope. Etsy keeps the file, so it can be re-associated with
 * {@link assignListingVideo}.
 */
export async function deleteListingVideo(params: {
  shopId: number;
  listingId: number;
  videoId: number;
}): Promise<void> {
  const path = `/shops/${params.shopId}/listings/${params.listingId}/videos/${params.videoId}`;
  await readEtsyResponse(await etsyFetch(path, { method: "DELETE" }), `DELETE ${path}`);
}
