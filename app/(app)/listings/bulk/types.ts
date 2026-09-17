/**
 * The shapes the bulk editor's screen works in — each one mirrors what a
 * route already returns, kept here so every component agrees on them without
 * importing server-only modules.
 */

import type { PersonalizationQuestionInput } from "@/lib/etsy/listing-personalization";
import type { BulkFieldKey, DimensionUnit, WeightUnit } from "@/lib/etsy/bulk-edit";
import type { ConfirmedListingFields } from "@/lib/etsy/listing-confirmed";

/** One listing as `GET /api/etsy/listings/bulk` returns it. */
export interface BulkListingDetail {
  listingId: number;
  title: string;
  description: string;
  tags: string[];
  materials: string[];
  state: string;
  url: string;
  thumbnailUrl: string | null;
  shopSectionId: number | null;
  shippingProfileId: number | null;
  returnPolicyId: number | null;
  readinessStateId: number | null;
  taxonomyId: number | null;
  whoMade: string;
  whenMade: string;
  isSupply: boolean;
  productionPartnerIds: number[];
  itemWeight: number | null;
  itemWeightUnit: WeightUnit | null;
  itemLength: number | null;
  itemWidth: number | null;
  itemHeight: number | null;
  itemDimensionsUnit: DimensionUnit | null;
  shouldAutoRenew: boolean;
  isTaxable: boolean;
  price: number | null;
  quantity: number;
  sku: string;
  images: { imageId: number; url: string; rank: number; altText: string }[];
  videos: { videoId: number; thumbnailUrl: string; videoUrl: string; state: string }[];
  personalizationQuestions: PersonalizationQuestionInput[];
  hasVariations: boolean;
}

export interface SectionOption {
  shopSectionId: number;
  title: string;
}
export interface ShippingProfileOption {
  shippingProfileId: number;
  title: string;
}
export interface ProcessingProfileOption {
  readinessStateId: number;
  readinessState: "ready_to_ship" | "made_to_order";
  minProcessingDays: number;
  maxProcessingDays: number;
  displayLabel: string;
}
export interface ReturnPolicyOption {
  returnPolicyId: number;
  label: string;
}
export interface ProductionPartnerOption {
  productionPartnerId: number;
  partnerName: string;
  location: string;
}

/** A taxonomy node flattened to its full path, e.g. "Home & Living > Kitchen > Mugs". */
export interface TaxonomyOption {
  id: number;
  path: string;
}

export interface TaxonomyPropertyValue {
  valueId: number | null;
  name: string;
  scaleId: number | null;
}
export interface TaxonomyProperty {
  propertyId: number;
  name: string;
  displayName: string;
  isRequired: boolean;
  isMultivalued: boolean;
  maxValuesAllowed: number | null;
  supportsAttributes: boolean;
  supportsVariations: boolean;
  scales: { scaleId: number; displayName: string }[];
  possibleValues: TaxonomyPropertyValue[];
}

/** One attribute as Etsy currently has it on a listing. */
export interface ListingAttribute {
  propertyId: number;
  propertyName: string;
  scaleId: number | null;
  valueIds: number[];
  values: string[];
}

export interface InventoryOption {
  valueId: number | null;
  name: string;
}
export interface InventoryProperty {
  propertyId: number;
  name: string;
  scaleId: number | null;
  options: InventoryOption[];
}
export interface InventoryCombination {
  key: string;
  valueIds: (number | null)[];
  values: string[];
  price: number | null;
  quantity: number;
  sku: string;
  enabled: boolean;
  readinessStateId: number | null;
}
/** One listing's variation grid, as `GET /api/etsy/listings/bulk/inventory` returns it. */
export interface InventorySnapshot {
  listingId: number;
  properties: InventoryProperty[];
  combinations: InventoryCombination[];
  priceOnProperty: number[];
  quantityOnProperty: number[];
  skuOnProperty: number[];
  readinessStateOnProperty: number[];
}

/** Etsy's who/what/when trio, edited together. */
export interface AboutValue {
  whoMade: string;
  whenMade: string;
  isSupply: boolean;
  productionPartnerIds: number[];
}

/** One Optional-group attribute's chosen values for one listing. */
export interface AttributeValue {
  propertyId: number;
  valueIds: number[];
  values: string[];
  scaleId: number | null;
}

export interface WeightValue {
  weight: string;
  unit: string;
}

export interface SizeValue {
  length: string;
  width: string;
  height: string;
  unit: string;
}

/**
 * The editable value of one field, in the shape its inputs use. Numbers are
 * carried as strings so a half-typed "12." never becomes NaN mid-edit.
 */
export type FieldValue =
  | string
  | boolean
  | string[]
  | AboutValue
  | AttributeValue
  | WeightValue
  | SizeValue
  | PersonalizationQuestionInput[]
  | InventorySnapshot;

export interface SaveResult {
  listingId: number;
  ok: boolean;
  /** Everything but the listing's variation photos was saved. */
  partial?: boolean;
  error?: string;
  /**
   * The listing's fields as Etsy reported them after the write. Rows are
   * refreshed from this, so a saved row never shows a value Etsy didn't
   * confirm storing.
   */
  confirmed?: ConfirmedListingFields;
}

/** Everything the option dropdowns need, loaded once by the editor. */
export interface BulkOptions {
  sections: SectionOption[];
  shippingProfiles: ShippingProfileOption[];
  processingProfiles: ProcessingProfileOption[];
  returnPolicies: ReturnPolicyOption[];
  productionPartners: ProductionPartnerOption[];
  taxonomy: TaxonomyOption[];
  /** Category properties, keyed by taxonomy id — loaded per category in the selection. */
  propertiesByTaxonomy: Record<number, TaxonomyProperty[]>;
}

export const EMPTY_OPTIONS: BulkOptions = {
  sections: [],
  shippingProfiles: [],
  processingProfiles: [],
  returnPolicies: [],
  productionPartners: [],
  taxonomy: [],
  propertiesByTaxonomy: {},
};

/** The sidebar's current selection: a field, and which group it was picked from. */
export interface FieldSelection {
  group: string;
  field: BulkFieldKey;
}
