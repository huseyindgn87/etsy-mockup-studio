import { etsyFetch } from "@/lib/etsy/auth";
import { EtsyApiError } from "@/lib/etsy/listings";

/**
 * Upload a rendered image to an Etsy listing (API v3).
 *
 * `POST /v3/application/shops/{shop_id}/listings/{listing_id}/images` —
 * multipart/form-data, `listings_w` scope. Etsy allows at most 10 images per
 * listing; `rank` must stay within `current_count + 1`, so callers upload
 * sequentially from rank 1.
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
  if (params.altText) form.append("alt_text", params.altText.slice(0, 500));

  const res = await etsyFetch(
    `/shops/${params.shopId}/listings/${params.listingId}/images`,
    { method: "POST", body: form },
  );
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const detail =
      body && typeof body === "object" && "error" in body
        ? String((body as { error: unknown }).error)
        : `Etsy responded ${res.status}`;
    throw new EtsyApiError(detail, res.status, body);
  }

  const raw = body as RawListingImage;
  return {
    listingImageId: raw.listing_image_id,
    rank: raw.rank,
    url: raw.url_fullxfull ?? raw.url_570xN ?? null,
  };
}
