import { etsyFetch } from "@/lib/etsy/auth";
import { decodeHtmlEntities, readEtsyResponse } from "@/lib/etsy/listings";
import { MAX_LISTING_IMAGES } from "@/lib/etsy/listing-image-limits";

/**
 * Everything the mockup editor needs to prefill a "copy" draft from an
 * existing listing — read-only, `GET`-only, never writes back to Etsy (see
 * memory `live-listing-never-auto-modified`). Photo bytes are embedded as
 * data URLs so the client can turn them straight into `File`s without a
 * second round trip or a cross-origin fetch of Etsy's CDN.
 */
export interface ListingCopySource {
  listingId: number;
  title: string;
  description: string;
  tags: string[];
  /** Price in major currency units, or null when Etsy omitted it. */
  price: number | null;
  shopSectionId: number | null;
  images: { dataUrl: string; fileName: string }[];
}

interface RawPrice {
  amount: number;
  divisor: number;
  currency_code: string;
}

interface RawImage {
  url_fullxfull?: string;
  url_570xN?: string;
  url_340x270?: string;
  url_170x135?: string;
  url_75x75?: string;
}

interface RawListingDetail {
  listing_id: number;
  title?: string;
  description?: string;
  tags?: string[];
  price?: RawPrice;
  shop_section_id?: number | null;
  images?: RawImage[];
}

function pickCopyImageUrl(img: RawImage): string | null {
  return img.url_fullxfull ?? img.url_570xN ?? img.url_340x270 ?? img.url_170x135 ?? img.url_75x75 ?? null;
}

function extensionFor(contentType: string): string {
  if (contentType.includes("png")) return "png";
  if (contentType.includes("webp")) return "webp";
  if (contentType.includes("gif")) return "gif";
  return "jpg";
}

/**
 * Downloads one listing photo and returns it as a data URL. Etsy's image
 * CDN is public (no auth needed) but plain `fetch` here, not `etsyFetch` —
 * this never touches the Etsy API itself. Failures are non-fatal to the
 * caller: a source listing with 8 photos where 1 fails to download should
 * still prefill the other 7, not block the whole copy.
 */
async function fetchImageAsDataUrl(url: string, index: number): Promise<{ dataUrl: string; fileName: string } | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const contentType = res.headers.get("content-type") || "image/jpeg";
    const buffer = Buffer.from(await res.arrayBuffer());
    const dataUrl = `data:${contentType};base64,${buffer.toString("base64")}`;
    return { dataUrl, fileName: `photo-${index + 1}.${extensionFor(contentType)}` };
  } catch {
    return null;
  }
}

/**
 * Read one listing's title/description/tags/price/section/photos for the
 * "copy" flow's editor prefill. Deliberately excludes everything
 * `getListingStructure` already covers for the *publish*-time seed
 * (category, shipping, how-it's-made-adjacent fields) — those are re-derived
 * fresh from Etsy at publish time regardless of what the editor shows.
 */
export async function getListingCopySource(listingId: number): Promise<ListingCopySource> {
  const raw = (await readEtsyResponse(
    await etsyFetch(`/listings/${listingId}?includes=Images`),
    `GET /listings/${listingId}`,
  )) as RawListingDetail;

  const imageUrls = (raw.images ?? [])
    .slice(0, MAX_LISTING_IMAGES)
    .map(pickCopyImageUrl)
    .filter((u): u is string => u != null);

  const downloaded = await Promise.all(imageUrls.map((url, i) => fetchImageAsDataUrl(url, i)));
  const images = downloaded.filter((img): img is { dataUrl: string; fileName: string } => img != null);

  return {
    listingId: raw.listing_id,
    title: decodeHtmlEntities(raw.title ?? ""),
    description: decodeHtmlEntities(raw.description ?? ""),
    tags: Array.isArray(raw.tags) ? raw.tags : [],
    price: raw.price && raw.price.divisor ? raw.price.amount / raw.price.divisor : null,
    shopSectionId:
      typeof raw.shop_section_id === "number" && raw.shop_section_id > 0 ? raw.shop_section_id : null,
    images,
  };
}
