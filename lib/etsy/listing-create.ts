import { etsyFetch } from "@/lib/etsy/auth";
import { EtsyApiError, readEtsyResponse } from "@/lib/etsy/listings";
import { toPersonalizationWire, type PersonalizationQuestionInput } from "@/lib/etsy/listing-personalization";

/**
 * Create a fresh draft listing so rendered mockups are never uploaded onto a
 * live listing without the user asking. Etsy API v3 has no "copy listing"
 * endpoint, so a copy is a new draft seeded from an existing listing's fields.
 */

export interface ListingStructure {
  title: string;
  description: string;
  quantity: number;
  /** Price in major currency units. */
  price: number;
  currencyCode: string;
  taxonomyId: number;
  shippingProfileId: number | null;
  returnPolicyId: number | null;
  /** The processing profile Etsy requires on every physical listing. */
  readinessStateId: number | null;
  tags: string[];
  materials: string[];
}

interface RawListing {
  title?: string;
  description?: string;
  quantity?: number;
  price?: { amount: number; divisor: number; currency_code: string };
  taxonomy_id?: number;
  shipping_profile_id?: number | null;
  return_policy_id?: number | null;
  readiness_state_id?: number | null;
  tags?: string[];
  materials?: string[];
}

/**
 * Read the structural fields of a listing (`GET /listings/{id}`) — used to
 * seed a "copy" draft's category/shipping/tags. Deliberately excludes
 * `who_made`/`when_made`/`is_supply`: those always come from the user's own
 * How it's made choices (see `listing-classification.ts`), never borrowed
 * from whatever listing happens to be selected as a source.
 */
export async function getListingStructure(
  listingId: number,
): Promise<ListingStructure> {
  const l = (await readEtsyResponse(
    await etsyFetch(`/listings/${listingId}`),
    `GET /listings/${listingId}`,
  )) as RawListing;
  return {
    title: l.title ?? "",
    description: l.description ?? "",
    quantity: l.quantity && l.quantity > 0 ? l.quantity : 1,
    price:
      l.price && l.price.divisor ? l.price.amount / l.price.divisor : 1,
    currencyCode: l.price?.currency_code ?? "USD",
    taxonomyId: l.taxonomy_id ?? 0,
    shippingProfileId: l.shipping_profile_id ?? null,
    returnPolicyId: l.return_policy_id ?? null,
    readinessStateId: l.readiness_state_id ?? null,
    tags: Array.isArray(l.tags) ? l.tags : [],
    materials: Array.isArray(l.materials) ? l.materials : [],
  };
}

export interface DraftListingInput {
  title: string;
  description: string;
  quantity: number;
  price: number;
  /** Always the user's own How it's made choice — never borrowed from a source listing. */
  whoMade: string;
  isSupply: boolean;
  whenMade: string;
  /** Etsy requires at least one when `whoMade` is `someone_else` (validated before this is called — see `howItsMadeError`). */
  productionPartnerIds?: number[];
  taxonomyId: number;
  shippingProfileId?: number | null;
  returnPolicyId?: number | null;
  /** Required by Etsy for every physical listing. */
  readinessStateId?: number | null;
  shopSectionId?: number | null;
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
  form.set("is_supply", String(input.isSupply));
  form.set("taxonomy_id", String(input.taxonomyId));
  if (input.shippingProfileId)
    form.set("shipping_profile_id", String(input.shippingProfileId));
  if (input.returnPolicyId)
    form.set("return_policy_id", String(input.returnPolicyId));
  if (input.readinessStateId)
    form.set("readiness_state_id", String(input.readinessStateId));
  if (input.shopSectionId) form.set("shop_section_id", String(input.shopSectionId));
  for (const t of input.tags ?? []) if (t) form.append("tags", t);
  for (const m of input.materials ?? []) if (m) form.append("materials", m);
  for (const id of input.productionPartnerIds ?? []) form.append("production_partner_ids", String(id));

  const body = (await readEtsyResponse(
    await etsyFetch(`/shops/${shopId}/listings`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    }),
    `POST /shops/${shopId}/listings`,
    form.toString(),
  )) as { listing_id?: number };

  if (!body.listing_id) {
    throw new EtsyApiError("Etsy did not return an id for the new draft.", 502, body);
  }
  return body.listing_id;
}

export interface ListingSettingsInput {
  /** Position in the shop's featured listings (1 = left-most). Etsy has no plain on/off — the Settings tab maps its toggle to rank 1. */
  featuredRank?: number | null;
  shouldAutoRenew?: boolean;
}

/**
 * Update listing-level settings not available on `createDraftListing`
 * (`featured_rank`, `should_auto_renew`) — `PATCH /shops/{shop}/listings/{listing}`.
 * Called as a follow-up once the draft already exists.
 */
export async function updateListingSettings(
  shopId: number,
  listingId: number,
  input: ListingSettingsInput,
): Promise<void> {
  const form = new URLSearchParams();
  if (input.featuredRank != null) form.set("featured_rank", String(input.featuredRank));
  if (input.shouldAutoRenew != null) form.set("should_auto_renew", String(input.shouldAutoRenew));
  if ([...form.keys()].length === 0) return;

  await readEtsyResponse(
    await etsyFetch(`/shops/${shopId}/listings/${listingId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    }),
    `PATCH /shops/${shopId}/listings/${listingId}`,
    form.toString(),
  );
}

export interface ListingPropertyInput {
  propertyId: number;
  valueIds: number[];
  values: string[];
  scaleId?: number | null;
}

/**
 * Set one category-specific listing property (colour, occasion, sleeve
 * length, ...). `PUT /shops/{shop}/listings/{listing}/properties/{property}` —
 * `value_ids` and `values` are parallel arrays (each selected option's id and
 * its display name together).
 */
export async function setListingProperty(
  shopId: number,
  listingId: number,
  input: ListingPropertyInput,
): Promise<void> {
  const form = new URLSearchParams();
  for (const id of input.valueIds) form.append("value_ids", String(id));
  for (const v of input.values) form.append("values", v);
  if (input.scaleId) form.set("scale_id", String(input.scaleId));

  await readEtsyResponse(
    await etsyFetch(
      `/shops/${shopId}/listings/${listingId}/properties/${input.propertyId}`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      },
    ),
    `PUT /shops/${shopId}/listings/${listingId}/properties/${input.propertyId}`,
    form.toString(),
  );
}

/**
 * Set the SKU (and price/quantity, which the endpoint requires together) on a
 * listing with no variations — `PUT /listings/{listing}/inventory` replaces
 * the whole product list, so this sends the single default product Etsy
 * already created for a no-variation listing, just with the SKU added.
 */
export async function setListingInventorySku(
  listingId: number,
  input: { sku: string; price: number; quantity: number },
): Promise<void> {
  const requestBody = {
    products: [
      {
        sku: input.sku.slice(0, 500),
        property_values: [],
        offerings: [
          {
            price: input.price > 0 ? input.price : 1,
            quantity: Math.max(1, Math.trunc(input.quantity)),
            is_enabled: true,
          },
        ],
      },
    ],
  };
  await readEtsyResponse(
    await etsyFetch(`/listings/${listingId}/inventory`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestBody),
    }),
    `PUT /listings/${listingId}/inventory`,
    requestBody,
  );
}

export interface InventoryProductInput {
  sku?: string;
  /** One entry per variation property this product is a combination of. A null id is a free-text value on an otherwise-real Etsy property. */
  propertyValues: { propertyId: number; name: string; valueIds: (number | null)[]; values: string[] }[];
  price: number;
  quantity: number;
  /** Etsy auto-assigns one when omitted. */
  readinessStateId?: number;
  /** Etsy still requires every combination to be supplied; false just marks it inactive. Defaults to true. */
  enabled?: boolean;
}

export interface UpdateInventoryInput {
  products: InventoryProductInput[];
  /** Property ids where price differs between combinations. */
  priceOnProperty?: number[];
  /** Property ids where quantity differs between combinations. */
  quantityOnProperty?: number[];
  /** Property ids where SKU differs between combinations. */
  skuOnProperty?: number[];
  /** Property ids where the processing/readiness profile differs between combinations. */
  readinessStateOnProperty?: number[];
}

/**
 * Replace a listing's full product/variation list — `PUT /listings/{listing}/inventory`.
 * One `products` entry per property-value combination (Etsy has no separate
 * "create variations" call; this endpoint always replaces the whole list, be
 * it the single default product or a full variation grid).
 *
 * `max_variations_supported=3` is required to write a 3rd variation type —
 * harmless to always send since 1-2 variation listings ignore it.
 */
export async function updateListingInventory(
  listingId: number,
  input: UpdateInventoryInput,
): Promise<void> {
  const requestBody = {
    products: input.products.map((p) => ({
      sku: p.sku ? p.sku.slice(0, 500) : null,
      property_values: p.propertyValues.map((pv) => ({
        property_id: pv.propertyId,
        property_name: pv.name,
        value_ids: pv.valueIds,
        values: pv.values,
      })),
      offerings: [
        {
          price: p.price > 0 ? p.price : 1,
          quantity: Math.max(0, Math.trunc(p.quantity)),
          is_enabled: p.enabled !== false,
          ...(p.readinessStateId ? { readiness_state_id: p.readinessStateId } : {}),
        },
      ],
    })),
    price_on_property: input.priceOnProperty ?? [],
    quantity_on_property: input.quantityOnProperty ?? [],
    sku_on_property: input.skuOnProperty ?? [],
    readiness_state_on_property: input.readinessStateOnProperty ?? [],
  };
  await readEtsyResponse(
    await etsyFetch(`/listings/${listingId}/inventory?max_variations_supported=3`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestBody),
    }),
    `PUT /listings/${listingId}/inventory`,
    requestBody,
  );
}

export interface VariationImageInput {
  propertyId: number;
  valueId: number;
  /** An already-uploaded listing image id. */
  imageId: number;
}

/**
 * Associate specific listing images with specific variation property values
 * (e.g. the "Red" value of a Colour variation shows a particular photo) —
 * `POST /shops/{shop}/listings/{listing}/variation-images`.
 */
export async function updateVariationImages(
  shopId: number,
  listingId: number,
  images: VariationImageInput[],
): Promise<void> {
  if (images.length === 0) return;
  const requestBody = {
    variation_images: images.map((i) => ({
      property_id: i.propertyId,
      value_id: i.valueId,
      image_id: i.imageId,
    })),
  };
  await readEtsyResponse(
    await etsyFetch(`/shops/${shopId}/listings/${listingId}/variation-images`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestBody),
    }),
    `POST /shops/${shopId}/listings/${listingId}/variation-images`,
    requestBody,
  );
}

/**
 * Create or replace a listing's personalization questions —
 * `POST /shops/{shop}/listings/{listing}/personalization`. Fully replaces
 * any existing personalization; see `listing-personalization.ts` for the
 * field constraints and why this isn't the older flat `is_personalizable`/
 * `personalization_*` fields (deprecated — not part of createDraftListing or
 * updateListing at all). Always sent with
 * `supports_multiple_personalization_questions=true`: without it, Etsy
 * treats the caller as a legacy single-question integration and refuses
 * (409) any request that would remove previously-configured questions.
 */
export async function updateListingPersonalization(
  shopId: number,
  listingId: number,
  questions: PersonalizationQuestionInput[],
): Promise<void> {
  const requestBody = { personalization_questions: questions.map(toPersonalizationWire) };
  await readEtsyResponse(
    await etsyFetch(
      `/shops/${shopId}/listings/${listingId}/personalization?supports_multiple_personalization_questions=true`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody),
      },
    ),
    `POST /shops/${shopId}/listings/${listingId}/personalization`,
    requestBody,
  );
}
