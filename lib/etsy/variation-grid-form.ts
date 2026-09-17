/**
 * Bridges a live listing's inventory grid (as the bulk editor reads it) and
 * the variation form the listing editor's Variations block edits, so the bulk
 * editor can show that same block per listing — and turns an edited form back
 * into the full replacement grid the bulk save writes.
 */

import type { BulkVariationImage, BulkVariations } from "@/lib/etsy/bulk-edit";
import type { VariationGrid } from "@/lib/etsy/variation-grid";
import { CUSTOM_PROPERTY_IDS, type CombinationField, type VariationDimension } from "@/lib/etsy/variation-combinations";
import { buildInventoryPayload, photoPropertyIndex, type OfferingState } from "@/lib/etsy/variation-offerings";

export interface ListingInventoryDefaults {
  price: number | null;
  quantity: number;
  sku: string;
  readinessStateId: number | null;
}

const PRICE_RE = /^\d+(\.\d{1,2})?$/;

/** A variation photo as Etsy reports it. */
export interface GridVariationImage {
  propertyId: number;
  valueId: number;
  value: string;
  imageId: number;
}

/** The photo tile id of a listing image — the same id the shared photo grid gives it. */
const etsySlotId = (imageId: number) => `etsy:${imageId}`;
const ETSY_SLOT_RE = /^etsy:(\d+)$/;

/**
 * A grid as the variation form holds it. Options Etsy stores as free text
 * (no value id) get negative ids, which the payload builder sends back as
 * `value_id: null`. A field on `*_on_property` gets one cell per value of
 * those properties; any other field is the listing-wide value. The listing's
 * variation photos mark their property as the photo variation and fill
 * `variationPhotos` with the photo grid's tile ids.
 */
export function gridToOfferingState(
  grid: VariationGrid,
  defaults: ListingInventoryDefaults,
  images: readonly GridVariationImage[] = [],
): OfferingState {
  const optionIds = grid.properties.map((property) => {
    let free = 0;
    return new Map(
      property.options.map((o) => [o.valueId == null ? `t:${o.name}` : String(o.valueId), o.valueId ?? --free]),
    );
  });
  const variations: VariationDimension[] = grid.properties.map((property, i) => ({
    propertyId: property.propertyId,
    name: property.name,
    isCustom: (CUSTOM_PROPERTY_IDS as readonly number[]).includes(property.propertyId),
    valueIds: [...optionIds[i].values()],
    values: property.options.map((o) => o.name),
    linksPhotos: images.length > 0 && property.propertyId === images[0].propertyId,
    scaleId: property.scaleId,
  }));

  const variationPhotos: Record<string, string> = {};
  const photoIndex = grid.properties.findIndex((p) => images.length > 0 && p.propertyId === images[0].propertyId);
  for (const image of photoIndex < 0 ? [] : images) {
    if (image.propertyId !== images[0].propertyId) continue;
    const formId = optionIds[photoIndex].get(String(image.valueId)) ?? optionIds[photoIndex].get(`t:${image.value}`);
    if (formId != null) variationPhotos[String(formId)] = etsySlotId(image.imageId);
  }

  const formIdsOf = (valueIds: (number | null)[], values: string[]) =>
    valueIds.map((id, i) => optionIds[i]?.get(id == null ? `t:${values[i]}` : String(id)) ?? 0);

  const first = grid.combinations[0];
  const onProperty: Record<CombinationField, number[]> = {
    price: grid.priceOnProperty,
    quantity: grid.quantityOnProperty,
    sku: grid.skuOnProperty,
    readiness: grid.readinessStateOnProperty,
  };
  const cellOf: Record<CombinationField, (c: VariationGrid["combinations"][number]) => string> = {
    price: (c) => (c.price == null ? "" : c.price.toFixed(2)),
    quantity: (c) => String(c.quantity),
    sku: (c) => c.sku,
    readiness: (c) => (c.readinessStateId == null ? "" : String(c.readinessStateId)),
  };

  const variationToggles = {} as OfferingState["variationToggles"];
  const variationRows = {} as OfferingState["variationRows"];
  for (const field of ["price", "quantity", "sku", "readiness"] as const) {
    const appliesTo = onProperty[field]
      .map((propertyId) => grid.properties.findIndex((p) => p.propertyId === propertyId))
      .filter((i) => i >= 0)
      .sort((a, b) => a - b);
    variationToggles[field] = { enabled: appliesTo.length > 0, appliesTo };
    variationRows[field] = {};
    if (appliesTo.length === 0) continue;
    for (const c of grid.combinations) {
      const ids = formIdsOf(c.valueIds, c.values);
      const key = appliesTo.map((i) => ids[i]).join(":");
      if (!(key in variationRows[field])) variationRows[field][key] = cellOf[field](c);
    }
  }

  const variationRowEnabled: Record<string, boolean> = {};
  for (const c of grid.combinations) {
    if (!c.enabled) variationRowEnabled[formIdsOf(c.valueIds, c.values).join(":")] = false;
  }

  const price = defaults.price ?? first?.price ?? null;
  const readiness = defaults.readinessStateId ?? first?.readinessStateId ?? null;
  return {
    variations,
    variationToggles,
    variationRows,
    variationRowEnabled,
    price: price == null ? "" : price.toFixed(2),
    quantity: String(first && grid.properties.length > 0 ? first.quantity : defaults.quantity),
    sku: (grid.properties.length > 0 ? first?.sku : undefined) ?? defaults.sku,
    readinessStateId: readiness,
    variationPhotos,
  };
}

/**
 * The listing's full set of variation photos as the form holds them, for the
 * bulk save — an empty list when none are assigned. Only photos already on
 * the listing (`etsy:` tiles) can be sent; Etsy refuses any other id.
 */
export function offeringStateToVariationImages(state: OfferingState): BulkVariationImage[] {
  const index = photoPropertyIndex(state.variations);
  if (index == null) return [];
  const d = state.variations[index];
  return d.valueIds.flatMap((valueId, i) => {
    const match = ETSY_SLOT_RE.exec(state.variationPhotos[String(valueId)] ?? "");
    return match
      ? [{ propertyId: d.propertyId, valueId: valueId < 0 ? null : valueId, value: d.values[i], imageId: Number(match[1]) }]
      : [];
  });
}

/**
 * The replacement grid a bulk save writes, or null when the form has no
 * complete grid. Rows that don't set a field take the form's listing-wide
 * value, so every product carries its own price and quantity.
 */
export function offeringStateToBulkVariations(state: OfferingState): BulkVariations | null {
  const payload = buildInventoryPayload(state, []);
  if (!payload) return null;
  const price = PRICE_RE.test(state.price.trim()) && Number(state.price) > 0 ? Number(state.price) : undefined;
  const quantity = /^\d+$/.test(state.quantity.trim()) ? Number(state.quantity) : undefined;
  const sku = state.sku.trim() || undefined;
  return {
    products: payload.products.map((p) => ({
      ...p,
      price: p.price ?? price,
      quantity: p.quantity ?? quantity,
      sku: p.sku ?? sku,
      readinessStateId: p.readinessStateId ?? state.readinessStateId ?? undefined,
    })),
    priceOnProperty: payload.priceOnProperty,
    quantityOnProperty: payload.quantityOnProperty,
    skuOnProperty: payload.skuOnProperty,
    readinessStateOnProperty: payload.readinessStateOnProperty,
  };
}
