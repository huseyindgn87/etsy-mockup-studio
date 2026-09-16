/**
 * Small shared pieces of the bulk editor's screen: the input styling every
 * control uses, the field labels its accessible names are built from, and the
 * per-listing resolution of an Optional-group attribute to the taxonomy
 * property that listing's own category actually has.
 */

import {
  BULK_GROUPS,
  findAttributeProperty,
  isAttributeField,
  type BulkFieldKey,
} from "@/lib/etsy/bulk-edit";
import type { BulkListingDetail, BulkOptions, TaxonomyProperty } from "./types";

export const INPUT_CLS =
  "w-full rounded-lg border border-black/10 bg-white px-2 text-sm outline-none focus:border-primary dark:border-white/15 dark:bg-zinc-950";

/** Each field's label, taken from the sidebar so the two can never disagree. */
export const FIELD_LABELS: Record<string, string> = Object.fromEntries(
  BULK_GROUPS.flatMap((group) => group.fields.map((field) => [field.key, field.label])),
);

export function labelFor(field: BulkFieldKey): string {
  return FIELD_LABELS[field] ?? field;
}

/**
 * Every row shows the same visible caption, so a control's own accessible
 * name carries the listing it belongs to — otherwise a screen reader (and a
 * test) hears one field repeated N times.
 */
export function ariaLabelFor(label: string, listing: BulkListingDetail): string {
  return `${label} for ${listing.title}`;
}

/**
 * The taxonomy property one Optional field maps to *for this listing*. Etsy's
 * attributes are category-specific: "Size" is a different property id on a
 * mug than on a t-shirt, and a category that has no such property simply
 * can't carry that attribute — the row then says so instead of offering a
 * dropdown that could never be saved.
 */
export function propertyForListing(
  field: BulkFieldKey,
  listing: BulkListingDetail,
  options: BulkOptions,
): TaxonomyProperty | null {
  if (!isAttributeField(field) || listing.taxonomyId == null) return null;
  const properties = options.propertiesByTaxonomy[listing.taxonomyId];
  if (!properties) return null;
  return findAttributeProperty(
    field,
    properties.filter((p) => p.supportsAttributes),
  );
}

/**
 * The value names one attribute offers across the whole selection — what the
 * apply-to-all dropdown lists. Values are matched to each row by *name*
 * rather than id on purpose: the same "Red" has a different value id on
 * different categories, so an id chosen once could not be written to a row in
 * another category.
 */
export function attributeChoicesAcross(
  field: BulkFieldKey,
  listings: readonly BulkListingDetail[],
  options: BulkOptions,
): string[] {
  const names = new Set<string>();
  for (const listing of listings) {
    const property = propertyForListing(field, listing, options);
    for (const value of property?.possibleValues ?? []) {
      if (value.valueId != null) names.add(value.name);
    }
  }
  return [...names].sort((a, b) => a.localeCompare(b));
}

/** The taxonomy path shown under a listing's title on the Category field. */
export function taxonomyPathFor(listing: BulkListingDetail, options: BulkOptions): string {
  if (listing.taxonomyId == null) return "";
  return options.taxonomy.find((t) => t.id === listing.taxonomyId)?.path ?? "";
}
