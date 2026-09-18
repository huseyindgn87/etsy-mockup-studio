import type { ListingFormValue } from "@/app/(app)/mockups/ListingForm";
import type { BulkAttributeValue, BulkListingPatch } from "@/lib/etsy/bulk-edit";
import { changedKeys, sameState, type UnsyncedChange } from "@/lib/etsy/listing-changes";
import { offeringStateToBulkVariations, offeringStateToVariationImages } from "@/lib/etsy/variation-grid-form";

type FormKey = keyof ListingFormValue;

/**
 * Which write each form field belongs to. A `Record` over every key, so a
 * field added to the form doesn't compile until it is given a writer here —
 * nothing can fall out of Sync to Etsy unnoticed.
 */
const FIELD_GROUP: Record<FormKey, Group> = {
  title: "title",
  description: "description",
  tags: "tags",
  taxonomyId: "category",
  taxonomyPath: "category",
  shopSectionId: "section",
  shopSectionTitle: "section",
  properties: "attributes",
  price: "inventory",
  quantity: "inventory",
  sku: "inventory",
  readinessStateId: "inventory",
  whoMade: "howMade",
  isSupply: "howMade",
  whenMade: "howMade",
  productionPartnerIds: "partners",
  personalizationQuestions: "personalization",
  variations: "inventory",
  variationToggles: "inventory",
  variationRows: "inventory",
  variationRowEnabled: "inventory",
  variationPhotos: "variationPhotos",
  featureListing: "featured",
  promoteWithAds: "ads",
  autoRenew: "autoRenew",
};

type Group =
  | "title"
  | "description"
  | "tags"
  | "category"
  | "section"
  | "attributes"
  | "inventory"
  | "howMade"
  | "partners"
  | "personalization"
  | "variationPhotos"
  | "featured"
  | "ads"
  | "autoRenew";

export interface EditorSyncPlan {
  patch: BulkListingPatch;
  /** Changes Etsy's API can't write — reported to the user, never dropped silently. */
  unsynced: UnsyncedChange[];
}

/**
 * Everything that turns the listing as Etsy holds it (`original`, the form the
 * editor loads for it) into the editor's form (`current`). Every field of the
 * form is compared; each difference becomes part of the bulk-save patch or,
 * when Etsy's API has no way to write it, an entry in `unsynced`. Photos and
 * videos are compared separately (`mediaChanges`). Returns an error instead
 * when the edit can't be expressed at all.
 */
export function editorSyncPatch(
  original: ListingFormValue,
  current: ListingFormValue,
): EditorSyncPlan | { error: string } {
  const patch: BulkListingPatch = {};
  const unsynced: UnsyncedChange[] = [];
  const groups = new Set(changedKeys(original, current).map((key) => FIELD_GROUP[key]));

  if (groups.has("title")) patch.title = current.title;
  if (groups.has("description")) patch.description = current.description;
  if (groups.has("tags")) patch.tags = current.tags;
  if (groups.has("howMade")) {
    patch.whoMade = current.whoMade;
    patch.whenMade = current.whenMade;
    patch.isSupply = current.isSupply;
  }
  if (groups.has("partners")) patch.productionPartnerIds = current.productionPartnerIds;
  if (groups.has("category")) {
    if (current.taxonomyId != null) patch.taxonomyId = current.taxonomyId;
    else unsynced.push({ field: "Category", reason: "Etsy's API has no way to remove a listing's category" });
  }
  if (groups.has("section")) {
    if (current.shopSectionId != null) patch.shopSectionId = current.shopSectionId;
    else {
      unsynced.push({
        field: "Shop section",
        reason: "Etsy's API documents no way to take a listing out of its section",
      });
    }
  }
  if (groups.has("personalization")) {
    patch.personalization = current.personalizationQuestions.filter((q) => q.questionText.trim() !== "");
  }
  if (groups.has("autoRenew")) patch.shouldAutoRenew = current.autoRenew;
  if (groups.has("featured")) {
    if (current.featureListing) patch.featuredRank = 1;
    else {
      unsynced.push({
        field: "Feature this listing",
        reason: "Etsy's API only sets a featured position and documents no way to un-feature a listing",
      });
    }
  }
  if (groups.has("ads")) {
    unsynced.push({ field: "Promote with Etsy Ads", reason: "Etsy's Open API has no endpoint for Etsy Ads" });
  }

  if (groups.has("attributes")) {
    const attributes: BulkAttributeValue[] = [];
    for (const propertyId of new Set(
      [...Object.keys(original.properties), ...Object.keys(current.properties)].map(Number),
    )) {
      const now = current.properties[propertyId];
      const was = original.properties[propertyId];
      if (sameState(now, was)) continue;
      if (!now || now.valueIds.length + now.values.length === 0) {
        unsynced.push({
          field: was?.name || `Attribute ${propertyId}`,
          reason: "Etsy's API documents no way to clear a category attribute",
        });
        continue;
      }
      attributes.push({
        propertyId,
        valueIds: now.valueIds,
        values: now.values,
        ...(now.scaleId != null ? { scaleId: now.scaleId } : {}),
      });
    }
    if (attributes.length > 0) patch.attributes = attributes;
  }

  const hasGrid = current.variations.length > 0 || original.variations.length > 0;
  if (hasGrid) {
    if (groups.has("inventory")) {
      const variations = offeringStateToBulkVariations(current);
      if (!variations) return { error: "Variations: a listing's last variation can't be removed from here." };
      patch.variations = variations;
    }
    if (groups.has("variationPhotos") || (patch.variations && Object.keys(current.variationPhotos).length > 0)) {
      patch.variationImages = offeringStateToVariationImages(current);
      const notOnEtsy = Object.values(current.variationPhotos).filter((slot) => !slot.startsWith("etsy:"));
      if (notOnEtsy.length > 0) {
        unsynced.push({
          field: "Variation photos",
          reason: `${notOnEtsy.length} chosen photo${notOnEtsy.length === 1 ? " isn't" : "s aren't"} on Etsy yet — sync again once the photos are uploaded`,
        });
      }
    }
  } else {
    if (groups.has("inventory")) {
      if (current.price !== original.price) {
        const price = Number(current.price);
        if (current.price.trim() !== "" && Number.isFinite(price) && price > 0) patch.price = price;
        else unsynced.push({ field: "Price", reason: "Etsy needs a price greater than 0" });
      }
      if (current.quantity !== original.quantity) {
        const quantity = Number(current.quantity);
        if (/^\d+$/.test(current.quantity.trim())) patch.quantity = quantity;
        else unsynced.push({ field: "Quantity", reason: "Etsy needs a whole number" });
      }
      if (current.sku !== original.sku) patch.sku = current.sku;
      if (current.readinessStateId !== original.readinessStateId) {
        if (current.readinessStateId != null) patch.readinessStateId = current.readinessStateId;
        else unsynced.push({ field: "Processing profile", reason: "Etsy requires one on every physical listing" });
      }
      for (const key of ["variationToggles", "variationRows", "variationRowEnabled"] as const) {
        if (!sameState(current[key], original[key])) {
          unsynced.push({ field: "Variations", reason: "the listing has no variations for these settings to apply to" });
          break;
        }
      }
    }
    if (groups.has("variationPhotos")) {
      unsynced.push({ field: "Variation photos", reason: "the listing has no variations to attach photos to" });
    }
  }

  return { patch, unsynced };
}
