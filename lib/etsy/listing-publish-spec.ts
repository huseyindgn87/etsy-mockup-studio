/**
 * The listing form → the `PublishSpec` Etsy is sent. Pure; shared by the
 * editor's Publish and "Schedule for later", and by the schedule runner,
 * which rebuilds it from the saved draft when it runs.
 *
 * A "copy" is published exactly like a "new" listing: everything comes from
 * the form, nothing from the listing it was copied from (its shipping profile
 * and return policy were stored in the form when the draft was made).
 */

import type { ListingFormValue } from "@/app/(app)/mockups/ListingForm";
import type { PublishSpec } from "@/lib/etsy/publish-listing";
import { buildInventoryPayload } from "@/lib/etsy/variation-offerings";

export type ListingPublishMode = "existing" | "copy" | "new";

export function publishSpecFromForm(
  form: ListingFormValue,
  options: { mode: ListingPublishMode; listingId: number | null; photoSlotIds: readonly string[] },
): PublishSpec {
  const { mode, listingId } = options;
  const spec: PublishSpec = { mode, ...(listingId != null ? { listingId } : {}) };
  if (mode === "existing") return spec;

  spec.howItsMade = {
    whoMade: form.whoMade,
    isSupply: form.isSupply,
    whenMade: form.whenMade,
    productionPartnerIds: form.productionPartnerIds,
  };
  const personalization = form.personalizationQuestions.filter((q) => q.questionText.trim() !== "");
  if (personalization.length > 0) {
    spec.personalization = personalization as PublishSpec["personalization"];
  }
  const price = Number.parseFloat(form.price);
  const quantity = Number.parseInt(form.quantity, 10);
  spec.newListing = {
    title: form.title.trim(),
    description: form.description.trim(),
    tags: form.tags,
    materials: form.materials,
    taxonomyId: form.taxonomyId ?? undefined,
    shopSectionId: form.shopSectionId ?? undefined,
    readinessStateId: form.readinessStateId ?? undefined,
    shippingProfileId: form.shippingProfileId ?? undefined,
    returnPolicyId: form.returnPolicyId ?? undefined,
    properties: Object.entries(form.properties).map(([id, p]) => ({
      propertyId: Number(id),
      name: p.name,
      valueIds: p.valueIds,
      values: p.values,
      scaleId: p.scaleId ?? undefined,
    })),
    price: Number.isFinite(price) && price > 0 ? price : undefined,
    quantity: Number.isInteger(quantity) && quantity > 0 ? quantity : undefined,
    sku: form.sku.trim() || undefined,
    variations: buildInventoryPayload(form, options.photoSlotIds),
    // featured_rank/should_auto_renew aren't settable on createDraftListing —
    // the server sends them via a follow-up updateListing call.
    featuredRank: form.featureListing ? 1 : undefined,
    shouldAutoRenew: form.autoRenew,
  };
  return spec;
}
