import { etsyFetch } from "@/lib/etsy/auth";
import { decodeHtmlEntities, readEtsyResponse } from "@/lib/etsy/listings";
import { MAX_LISTING_IMAGES } from "@/lib/etsy/listing-image-limits";
import { fetchListingAttributes } from "@/lib/etsy/listing-attributes";
import { fetchListingDetails } from "@/lib/etsy/listing-details";
import { fetchListingInventories } from "@/lib/etsy/listing-inventory";
import { getSellerTaxonomyTree, type TaxonomyNode } from "@/lib/etsy/taxonomy";
import { listingFormFromSource, type EditorListingSource } from "@/lib/etsy/listing-editor-form";
import type { ListingFormValue } from "@/app/(app)/mockups/ListingForm";

/**
 * Everything the mockup editor needs to prefill a "copy" draft from an
 * existing listing — read-only, `GET`-only, never writes back to Etsy (see
 * memory `live-listing-never-auto-modified`). Photo bytes are embedded as
 * data URLs so the client can turn them straight into `File`s without a
 * second round trip or a cross-origin fetch of Etsy's CDN.
 */
export interface ListingCopySource {
  form: ListingFormValue;
  /** In rank order, each with the source photo's own alt text. */
  images: { dataUrl: string; fileName: string; altText: string }[];
}

interface RawPrice {
  amount: number;
  divisor: number;
  currency_code: string;
}

interface RawPrice {
  amount: number;
  divisor: number;
  currency_code: string;
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

function taxonomyPath(nodes: TaxonomyNode[], id: number, prefix = ""): string | null {
  for (const n of nodes) {
    const path = prefix ? `${prefix} > ${n.name}` : n.name;
    if (n.id === id) return path;
    const found = taxonomyPath(n.children, id, path);
    if (found) return found;
  }
  return null;
}

/**
 * Read a listing's all copyable fields (title/description/tags/price/section/
 * category/variations/attributes/photos) for the "copy" flow's editor prefill.
 * Fetches from the Etsy API to get the complete listing structure.
 */
export async function getListingCopySource(listingId: number): Promise<ListingCopySource> {
  const [detail] = await fetchListingDetails([listingId]);
  if (!detail) throw new Error("Listing not found");
  if (!detail.shopId) throw new Error("Shop id not available");

  const [inventories, attributes, tree] = await Promise.all([
    fetchListingInventories([listingId]),
    fetchListingAttributes(detail.shopId, [listingId]),
    detail.taxonomyId ? getSellerTaxonomyTree().catch(() => []) : Promise.resolve([]),
  ]);

  const inventory = inventories.get(listingId) ?? null;
  const listingAttributes = attributes.get(listingId) ?? [];

  // Build EditorListingSource with all available data
  const source: EditorListingSource = {
    title: decodeHtmlEntities(detail.title ?? ""),
    description: decodeHtmlEntities(detail.description ?? ""),
    tags: detail.tags ?? [],
    materials: detail.materials ?? [],
    price: detail.price ?? null,
    quantity: detail.quantity ?? 1,
    sku: detail.sku ?? "",
    shopSectionId: detail.shopSectionId ?? null,
    readinessStateId: detail.readinessStateId ?? null,
    shippingProfileId: detail.shippingProfileId ?? null,
    returnPolicyId: detail.returnPolicyId ?? null,
    whoMade: detail.whoMade ?? null,
    whenMade: detail.whenMade ?? null,
    isSupply: detail.isSupply ?? false,
    productionPartnerIds: detail.productionPartnerIds ?? [],
    taxonomyId: detail.taxonomyId ?? null,
    taxonomyPath: detail.taxonomyId ? (taxonomyPath(tree, detail.taxonomyId) ?? "") : "",
    attributes: listingAttributes,
    personalizationQuestions: detail.personalizationQuestions ?? [],
    featured: detail.featured ?? false,
    autoRenew: detail.shouldAutoRenew ?? true,
    inventory,
  };

  // Build the complete form using the existing function
  const form = listingFormFromSource(source);

  // Download images as data URLs
  const imageData = (detail.images ?? [])
    .slice(0, MAX_LISTING_IMAGES)
    .map((img) => ({ url: img.url, altText: img.altText ?? "" }))
    .filter((img): img is { url: string; altText: string } => img.url != null);

  const downloaded = await Promise.all(
    imageData.map(async (src, i) => {
      const img = await fetchImageAsDataUrl(src.url, i);
      return img ? { ...img, altText: src.altText } : null;
    }),
  );
  const images = downloaded.filter(
    (img): img is { dataUrl: string; fileName: string; altText: string } => img != null,
  );

  return { form, images };
}
