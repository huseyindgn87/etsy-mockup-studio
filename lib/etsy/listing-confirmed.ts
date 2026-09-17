/**
 * What Etsy says a listing holds *after* a write, read out of the
 * `updateListing` PATCH response.
 *
 * A save used to fold the patch it had just sent back into the row, so the
 * screen showed whatever the app believed it had written — including a tag
 * list Etsy had silently reduced to its last entry (see `joinList`). Etsy
 * echoes the whole updated listing, so the row is refreshed from that instead
 * and can only ever display values Etsy confirmed.
 *
 * Only fields the response actually carries are returned: a field Etsy leaves
 * out stays absent rather than being reported as empty. Inventory-side values
 * (price, quantity, SKU) are not part of this response and keep coming from
 * their own write.
 *
 * Pure — no Etsy calls, no DB.
 */

import { decodeHtmlEntities } from "@/lib/etsy/listings";
import type { DimensionUnit, WeightUnit } from "@/lib/etsy/bulk-edit";

/** The subset of a listing Etsy's update response confirms. */
export interface ConfirmedListingFields {
  title?: string;
  description?: string;
  tags?: string[];
  materials?: string[];
  whoMade?: string;
  whenMade?: string;
  isSupply?: boolean;
  productionPartnerIds?: number[];
  taxonomyId?: number | null;
  shopSectionId?: number | null;
  shippingProfileId?: number | null;
  returnPolicyId?: number | null;
  itemWeight?: number | null;
  itemWeightUnit?: WeightUnit | null;
  itemLength?: number | null;
  itemWidth?: number | null;
  itemHeight?: number | null;
  itemDimensionsUnit?: DimensionUnit | null;
  shouldAutoRenew?: boolean;
  isTaxable?: boolean;
}

function stringList(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((v) => typeof v === "string") ? (value as string[]) : undefined;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && value > 0 ? value : null;
}

/**
 * Read the confirmed fields out of one `updateListing` response body.
 * Anything that isn't a listing object gives `null`, so a caller that got
 * something unexpected back falls back to what it sent rather than wiping the
 * row.
 */
export function confirmedListingFields(body: unknown): ConfirmedListingFields | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const raw = body as Record<string, unknown>;
  if (!Number.isInteger(raw.listing_id)) return null;

  const confirmed: ConfirmedListingFields = {};
  if (typeof raw.title === "string") confirmed.title = decodeHtmlEntities(raw.title);
  if (typeof raw.description === "string") confirmed.description = decodeHtmlEntities(raw.description);

  const tags = stringList(raw.tags);
  if (tags) confirmed.tags = tags;
  const materials = stringList(raw.materials);
  if (materials) confirmed.materials = materials;

  if (typeof raw.who_made === "string") confirmed.whoMade = raw.who_made;
  if (typeof raw.when_made === "string") confirmed.whenMade = raw.when_made;
  if (typeof raw.is_supply === "boolean") confirmed.isSupply = raw.is_supply;

  if (Array.isArray(raw.production_partners)) {
    confirmed.productionPartnerIds = raw.production_partners
      .map((p) => (p as { production_partner_id?: unknown } | null)?.production_partner_id)
      .filter((id): id is number => Number.isInteger(id) && (id as number) > 0);
  }

  if ("taxonomy_id" in raw) confirmed.taxonomyId = numberOrNull(raw.taxonomy_id);
  if ("shop_section_id" in raw) confirmed.shopSectionId = numberOrNull(raw.shop_section_id);
  if ("shipping_profile_id" in raw) confirmed.shippingProfileId = numberOrNull(raw.shipping_profile_id);
  if ("return_policy_id" in raw) confirmed.returnPolicyId = numberOrNull(raw.return_policy_id);

  if ("item_weight" in raw) confirmed.itemWeight = numberOrNull(raw.item_weight);
  if ("item_length" in raw) confirmed.itemLength = numberOrNull(raw.item_length);
  if ("item_width" in raw) confirmed.itemWidth = numberOrNull(raw.item_width);
  if ("item_height" in raw) confirmed.itemHeight = numberOrNull(raw.item_height);
  if ("item_weight_unit" in raw) {
    confirmed.itemWeightUnit = (raw.item_weight_unit || null) as WeightUnit | null;
  }
  if ("item_dimensions_unit" in raw) {
    confirmed.itemDimensionsUnit = (raw.item_dimensions_unit || null) as DimensionUnit | null;
  }

  if (typeof raw.should_auto_renew === "boolean") confirmed.shouldAutoRenew = raw.should_auto_renew;
  if (typeof raw.is_taxable === "boolean") confirmed.isTaxable = raw.is_taxable;

  return confirmed;
}
