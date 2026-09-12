import { etsyFetch } from "@/lib/etsy/auth";
import { EtsyApiError } from "@/lib/etsy/listings";

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
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const detail =
      body && typeof body === "object" && "error" in body
        ? String((body as { error: unknown }).error)
        : `Etsy responded ${res.status}`;
    throw new EtsyApiError(detail, res.status, body);
  }

  const raw = body as RawListingVideo;
  return {
    videoId: raw.video_id,
    videoUrl: raw.video_url ?? null,
    thumbnailUrl: raw.thumbnail_url ?? null,
  };
}
