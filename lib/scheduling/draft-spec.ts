/**
 * What a scheduled listing publishes, read from its draft when it runs — so a
 * draft saved after scheduling is published as saved, never as it was when
 * scheduled. Only the rendered images are fixed at schedule time; the editor
 * re-renders them when a save changes the photos. Pure.
 */

import type { ListingFormValue } from "@/app/(app)/mockups/ListingForm";
import { slotIdFor, type ImageSlotRef } from "@/app/components/listing-media/photo-order";
import { MAX_ALT_TEXT_LENGTH } from "@/lib/etsy/listing-image-limits";
import { publishSpecFromForm } from "@/lib/etsy/listing-publish-spec";
import type { PublishSpec } from "@/lib/etsy/publish-listing";
import type { ScheduledImage } from "./types";

/** The draft columns a scheduled publish reads. */
export interface ScheduledDraft {
  formData: unknown;
  photosData: unknown;
  sourceMode: string | null;
  sourceListingId: string | null;
}

const toggle = () => ({ enabled: false, appliesTo: [] as number[] });

/** The editor's empty form — a saved draft's `formData` is laid over it, as the editor does when it opens one. */
const BLANK_FORM: ListingFormValue = {
  title: "",
  description: "",
  tags: [],
  taxonomyId: null,
  taxonomyPath: "",
  shopSectionId: null,
  shopSectionTitle: "",
  properties: {},
  price: "",
  quantity: "1",
  sku: "",
  readinessStateId: null,
  whoMade: "i_did",
  isSupply: false,
  whenMade: "made_to_order",
  productionPartnerIds: [],
  personalizationQuestions: [],
  variations: [],
  variationToggles: { price: toggle(), readiness: toggle(), quantity: toggle(), sku: toggle() },
  variationRows: { price: {}, readiness: {}, quantity: {}, sku: {} },
  variationRowEnabled: {},
  variationPhotos: {},
  featureListing: false,
  promoteWithAds: false,
  autoRenew: true,
};

const asRecord = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

/**
 * The grid slot each stored image came from, in upload order. Images stored
 * before slots were recorded fall back to the draft's grid order (photos
 * already on Etsy are never among a schedule's images).
 */
function imageSlotIds(images: ScheduledImage[], photos: Record<string, unknown>): string[] {
  if (images.every((i) => typeof i.slotId === "string")) return images.map((i) => i.slotId as string);
  const order = Array.isArray(photos.imageOrder) ? (photos.imageOrder as ImageSlotRef[]) : [];
  return order.filter((r) => r && r.kind !== "etsy").map(slotIdFor).slice(0, images.length);
}

/** The publish payload and the images' alt text, as the draft holds them now. */
export function publishSpecFromDraft(
  draft: ScheduledDraft,
  images: ScheduledImage[],
): { spec: PublishSpec; images: ScheduledImage[] } {
  const form: ListingFormValue = { ...BLANK_FORM, ...(asRecord(draft.formData) as Partial<ListingFormValue>) };
  const photos = asRecord(draft.photosData);
  const mode = draft.sourceMode === "copy" ? "copy" : draft.sourceMode === "existing" ? "existing" : "new";
  const sourceId = draft.sourceListingId != null ? Number(draft.sourceListingId) : NaN;
  const slotIds = imageSlotIds(images, photos);
  const spec = publishSpecFromForm(form, {
    mode,
    listingId: Number.isInteger(sourceId) && sourceId > 0 ? sourceId : null,
    photoSlotIds: slotIds,
  });

  const altTextBySlot = asRecord(photos.altTextBySlot);
  const withAltText = images.map((image, i) => {
    const text = altTextBySlot[slotIds[i]];
    const rest: ScheduledImage = { ...image };
    delete rest.altText;
    return typeof text === "string" && text.trim() ? { ...rest, altText: text.slice(0, MAX_ALT_TEXT_LENGTH) } : rest;
  });
  return { spec, images: withAltText };
}
