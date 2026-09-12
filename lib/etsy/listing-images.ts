import { etsyFetch } from "@/lib/etsy/auth";
import { readEtsyResponse } from "@/lib/etsy/listings";
import { MAX_ALT_TEXT_LENGTH } from "@/lib/etsy/listing-image-limits";

/**
 * Upload a rendered image to an Etsy listing (API v3).
 *
 * `POST /v3/application/shops/{shop_id}/listings/{listing_id}/images` —
 * multipart/form-data, `listings_w` scope. Etsy allows at most
 * `MAX_LISTING_IMAGES` images per listing (see `listing-image-limits.ts`);
 * `rank` must stay within `current_count + 1`, so callers upload sequentially
 * from rank 1.
 */

export interface UploadedListingImage {
  listingImageId: number;
  rank: number;
  url: string | null;
}

interface RawListingImage {
  listing_image_id: number;
  rank: number;
  url_fullxfull?: string;
  url_570xN?: string;
}

export async function uploadListingImage(params: {
  shopId: number;
  listingId: number;
  bytes: Uint8Array;
  filename: string;
  contentType: string;
  rank?: number;
  overwrite?: boolean;
  altText?: string;
}): Promise<UploadedListingImage> {
  const form = new FormData();
  form.append(
    "image",
    // copy into a fresh, non-shared buffer so it is a valid BlobPart
    new Blob([new Uint8Array(params.bytes)], { type: params.contentType }),
    params.filename,
  );
  if (params.rank != null) form.append("rank", String(Math.trunc(params.rank)));
  if (params.overwrite) form.append("overwrite", "true");
  if (params.altText) form.append("alt_text", params.altText.slice(0, MAX_ALT_TEXT_LENGTH));

  const res = await etsyFetch(
    `/shops/${params.shopId}/listings/${params.listingId}/images`,
    { method: "POST", body: form },
  );
  // The body is multipart (binary image) — log its metadata, not the bytes.
  const raw = (await readEtsyResponse(
    res,
    `POST /shops/${params.shopId}/listings/${params.listingId}/images`,
    {
      filename: params.filename,
      contentType: params.contentType,
      bytes: params.bytes.length,
      rank: params.rank,
      overwrite: params.overwrite,
      altText: params.altText,
    },
  )) as RawListingImage;
  return {
    listingImageId: raw.listing_image_id,
    rank: raw.rank,
    url: raw.url_fullxfull ?? raw.url_570xN ?? null,
  };
}
