import type { ListingFormValue } from "@/app/(app)/mockups/ListingForm";
import type { BulkAttributeValue, BulkListingPatch } from "@/lib/etsy/bulk-edit";
import { offeringStateToBulkVariations, offeringStateToVariationImages } from "@/lib/etsy/variation-grid-form";

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const sameSet = (a: readonly number[], b: readonly number[]) => same([...a].sort(), [...b].sort());

/**
 * The bulk-save patch that turns the listing as Etsy holds it (`original`, the
 * form the editor loads for it) into the editor's form (`current`). Only
 * changed fields are carried. Photos and videos are not part of it — the
 * editor's Save to Etsy writes those. Returns an error instead when the edit
 * can't be expressed as a patch.
 */
export function editorSyncPatch(
  original: ListingFormValue,
  current: ListingFormValue,
): { patch: BulkListingPatch } | { error: string } {
  const patch: BulkListingPatch = {};

  if (current.title !== original.title) patch.title = current.title;
  if (current.description !== original.description) patch.description = current.description;
  if (!same(current.tags, original.tags)) patch.tags = current.tags;
  if (
    current.whoMade !== original.whoMade ||
    current.whenMade !== original.whenMade ||
    current.isSupply !== original.isSupply
  ) {
    patch.whoMade = current.whoMade;
    patch.whenMade = current.whenMade;
    patch.isSupply = current.isSupply;
  }
  if (!sameSet(current.productionPartnerIds, original.productionPartnerIds)) {
    patch.productionPartnerIds = current.productionPartnerIds;
  }
  if (current.taxonomyId != null && current.taxonomyId !== original.taxonomyId) patch.taxonomyId = current.taxonomyId;
  if (current.shopSectionId != null && current.shopSectionId !== original.shopSectionId) {
    patch.shopSectionId = current.shopSectionId;
  }
  if (!same(current.personalizationQuestions, original.personalizationQuestions)) {
    patch.personalization = current.personalizationQuestions;
  }
  if (current.autoRenew !== original.autoRenew) patch.shouldAutoRenew = current.autoRenew;

  const attributes: BulkAttributeValue[] = [];
  const propertyIds = new Set([...Object.keys(original.properties), ...Object.keys(current.properties)].map(Number));
  for (const propertyId of propertyIds) {
    const now = current.properties[propertyId];
    if (same(now, original.properties[propertyId])) continue;
    attributes.push({
      propertyId,
      valueIds: now?.valueIds ?? [],
      values: now?.values ?? [],
      ...(now?.scaleId != null ? { scaleId: now.scaleId } : {}),
    });
  }
  if (attributes.length > 0) patch.attributes = attributes;

  const hasGrid = current.variations.length > 0 || original.variations.length > 0;
  if (hasGrid) {
    const gridOf = (f: ListingFormValue) => [
      f.variations,
      f.variationToggles,
      f.variationRows,
      f.variationRowEnabled,
      f.price,
      f.quantity,
      f.sku,
      f.readinessStateId,
    ];
    if (!same(gridOf(current), gridOf(original))) {
      const variations = offeringStateToBulkVariations(current);
      if (!variations) return { error: "Variations: a listing's last variation can't be removed from here." };
      patch.variations = variations;
    }
    if (!same(current.variationPhotos, original.variationPhotos)) {
      patch.variationImages = offeringStateToVariationImages(current);
    }
  } else {
    if (current.price.trim() !== original.price.trim() && current.price.trim() !== "") {
      patch.price = Number(current.price);
    }
    if (current.quantity.trim() !== original.quantity.trim() && current.quantity.trim() !== "") {
      patch.quantity = Number(current.quantity);
    }
    if (current.sku !== original.sku) patch.sku = current.sku;
    if (current.readinessStateId != null && current.readinessStateId !== original.readinessStateId) {
      patch.readinessStateId = current.readinessStateId;
    }
  }

  return { patch };
}
