import { etsyFetch } from "@/lib/etsy/auth";
import { EtsyApiError } from "@/lib/etsy/listings";

/**
 * Create a fresh draft listing so rendered mockups are never uploaded onto a
 * live listing without the user asking. Etsy API v3 has no "copy listing"
 * endpoint, so a copy is a new draft seeded from an existing listing's fields.
 */

async function readJson(res: Response): Promise<unknown> {
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const detail =
      body && typeof body === "object" && "error" in body
        ? String((body as { error: unknown }).error)
        : `Etsy responded ${res.status}`;
    throw new EtsyApiError(detail, res.status, body);
  }
  return body;
}

export interface ListingStructure {
  title: string;
  description: string;
  quantity: number;
  /** Price in major currency units. */
  price: number;
  currencyCode: string;
  whoMade: string;
  whenMade: string;
  taxonomyId: number;
  shippingProfileId: number | null;
  returnPolicyId: number | null;
  tags: string[];
  materials: string[];
}

interface RawListing {
  title?: string;
  description?: string;
  quantity?: number;
  price?: { amount: number; divisor: number; currency_code: string };
  who_made?: string;
  when_made?: string;
  taxonomy_id?: number;
  shipping_profile_id?: number | null;
  return_policy_id?: number | null;
  tags?: string[];
  materials?: string[];
}

/** Read the structural fields of a listing (`GET /listings/{id}`). */
export async function getListingStructure(
  listingId: number,
): Promise<ListingStructure> {
  const l = (await readJson(await etsyFetch(`/listings/${listingId}`))) as RawListing;
  return {
    title: l.title ?? "",
    description: l.description ?? "",
    quantity: l.quantity && l.quantity > 0 ? l.quantity : 1,
    price:
      l.price && l.price.divisor ? l.price.amount / l.price.divisor : 1,
    currencyCode: l.price?.currency_code ?? "USD",
    whoMade: l.who_made ?? "i_did",
    whenMade: l.when_made ?? "made_to_order",
    taxonomyId: l.taxonomy_id ?? 0,
    shippingProfileId: l.shipping_profile_id ?? null,
    returnPolicyId: l.return_policy_id ?? null,
    tags: Array.isArray(l.tags) ? l.tags : [],
    materials: Array.isArray(l.materials) ? l.materials : [],
  };
}

export interface DraftListingInput {
  title: string;
  description: string;
  quantity: number;
  price: number;
  whoMade: string;
  whenMade: string;
  taxonomyId: number;
  shippingProfileId?: number | null;
  returnPolicyId?: number | null;
  tags?: string[];
  materials?: string[];
}

/**
 * Create a draft listing (`POST /shops/{shop}/listings`). Always `draft` state —
 * the user reviews and publishes it on Etsy. Returns the new listing id.
 */
export async function createDraftListing(
  shopId: number,
  input: DraftListingInput,
): Promise<number> {
  const form = new URLSearchParams();
  form.set("quantity", String(Math.max(1, Math.trunc(input.quantity))));
  form.set("title", input.title.slice(0, 140));
  form.set("description", input.description || input.title);
  form.set("price", (input.price > 0 ? input.price : 1).toFixed(2));
  form.set("who_made", input.whoMade);
  form.set("when_made", input.whenMade);
  form.set("taxonomy_id", String(input.taxonomyId));
  if (input.shippingProfileId)
    form.set("shipping_profile_id", String(input.shippingProfileId));
  if (input.returnPolicyId)
    form.set("return_policy_id", String(input.returnPolicyId));
  for (const t of input.tags ?? []) if (t) form.append("tags", t);
  for (const m of input.materials ?? []) if (m) form.append("materials", m);

  const body = (await readJson(
    await etsyFetch(`/shops/${shopId}/listings`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    }),
  )) as { listing_id?: number };

  if (!body.listing_id) {
    throw new EtsyApiError("Etsy did not return an id for the new draft.", 502, body);
  }
  return body.listing_id;
}
