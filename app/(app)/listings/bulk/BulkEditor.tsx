"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  BULK_GROUPS,
  MAX_MATERIALS,
  MAX_MATERIAL_LENGTH,
  MAX_TAGS,
  MAX_TAG_LENGTH,
  applyKindFor,
  isAttributeField,
  isReadOnlyField,
  type BulkAttributeValue,
  type BulkFieldKey,
  type BulkListingPatch,
} from "@/lib/etsy/bulk-edit";
import { appendToList, applyTextTransform } from "@/lib/etsy/bulk-text";
import {
  applyNumericToForm,
  applyNumericToValue,
  applyProcessingToForm,
  applySkuText,
  applySkuToForm,
} from "@/lib/etsy/bulk-operations";
import type { VariationGrid } from "@/lib/etsy/variation-grid";
import type { BulkVariationImage } from "@/lib/etsy/bulk-edit";
import {
  gridToOfferingState,
  offeringStateToBulkVariations,
  offeringStateToVariationImages,
  type GridVariationImage,
} from "@/lib/etsy/variation-grid-form";
import { validateOfferings } from "@/lib/etsy/variation-offerings";
import { DEFAULT_AI_MODEL, isUsableAiSettings, type AiField } from "@/lib/ai/listing-ai";
import type { PersonalizationQuestionInput } from "@/lib/etsy/listing-personalization";
import { EMPTY_LISTING_FORM, type ListingFormValue } from "@/app/(app)/mockups/ListingForm";
import AiEditsBar, { type AiSettings } from "./AiEditsBar";
import BulkApplyControl, { type ApplyInstruction } from "./BulkApplyControl";
import BulkFieldInput, { INVENTORY_LOCKED } from "./BulkFieldInput";
import BulkSidebar from "./BulkSidebar";
import { ListingMediaEditor } from "@/app/components/listing-media/ListingMedia";
import {
  addMediaPhotos,
  initialExistingMedia,
  mediaPhotoSlots,
  mediaSaveForm,
  mediaSavePayload,
  moveMediaPhoto,
  moveMediaVideo,
  removeMediaPhoto,
  setMediaAltText,
  setMediaVideo,
  type ExistingMediaState,
} from "@/app/components/listing-media/existing-media";
import { checkPickedVideo } from "@/app/components/listing-media/video-file";
import { useUnsavedChangesGuard } from "@/app/components/unsaved-changes/useUnsavedChangesGuard";
import { useToast } from "@/app/components/toast/ToastProvider";
import ScheduleDialog from "@/app/(app)/schedule/ScheduleDialog";
import { bulkMediaSlot } from "@/lib/scheduling/render-keys";
import type { ConfirmedListingFields } from "@/lib/etsy/listing-confirmed";
import {
  describeUnsynced,
  mediaChanges as gridChanges,
  mediaStateFromEtsy,
  mediaStateFromGrid,
  sameState,
  type UnsyncedChange,
} from "@/lib/etsy/listing-changes";
import { slotIdFor } from "@/app/components/listing-media/photo-order";
import type { ScheduledBulkUpdate, ScheduledImageEntry, ScheduledVideoEntry } from "@/lib/scheduling/bulk-job";
import type { ScheduleTimeInput } from "@/lib/scheduling/types";
import { syncListingPatch, writeWithTimeout } from "@/lib/etsy/sync-request";
import { JobStatus } from "@/app/components/jobs/JobStatus";
import type { JobView } from "@/lib/jobs/types";
import VariationRowBlock, { VARIATION_FIELDS } from "./VariationRowBlock";
import VirtualListingRows from "./VirtualListingRows";
import { INPUT_CLS, attributeChoicesAcross, labelFor, propertyForListing } from "./helpers";
import {
  EMPTY_OPTIONS,
  type AboutValue,
  type AttributeValue,
  type BulkListingDetail,
  type BulkOptions,
  type FieldSelection,
  type FieldValue,
  type ListingAttribute,
  type SaveResult,
  type SizeValue,
  type TaxonomyOption,
  type TaxonomyProperty,
  type WeightValue,
} from "./types";

async function errorFrom(res: Response): Promise<string> {
  const body = (await res.json().catch(() => null)) as { error?: string } | null;
  return body?.error || `Request failed (${res.status})`;
}

/**
 * Uploads one photo or video a scheduled bulk edit adds, into the job's own
 * storage prefix, and returns the stored file as the job records it.
 */
async function storeScheduledFile(
  setId: string,
  listingId: number,
  kind: "image" | "video",
  index: number,
  file: File,
): Promise<{ key: string; filename: string; contentType: string }> {
  const contentType = file.type || (kind === "image" ? "image/jpeg" : "video/mp4");
  const res = await fetch(`/api/schedule/renders/${setId}/${bulkMediaSlot(listingId, kind, index)}`, {
    method: "PUT",
    headers: { "Content-Type": contentType },
    body: file,
  });
  if (!res.ok) throw new Error(await errorFrom(res));
  const { key } = (await res.json()) as { key: string };
  return { key, filename: file.name || `${kind}-${index + 1}`, contentType };
}

/** One listing's media and field writes, reported as a single row result. */
function mergeResults(listingId: number, steps: SaveResult[]): SaveResult {
  return steps.reduce((earlier, step) => {
    const ok = earlier.ok && step.ok;
    const failedOutright = [earlier, step].some((r) => !r.ok && !r.partial);
    return {
      listingId,
      ok,
      ...(!ok && !failedOutright ? { partial: true } : {}),
      ...(ok ? {} : { error: [earlier.error, step.error].filter(Boolean).join("; ") }),
    };
  });
}

interface TaxonomyNode {
  id: number;
  name: string;
  children: TaxonomyNode[];
}

/** Etsy's category tree, flattened to the full paths the pickers show. */
function flattenTaxonomy(nodes: TaxonomyNode[], prefix = ""): TaxonomyOption[] {
  const out: TaxonomyOption[] = [];
  for (const node of nodes) {
    const path = prefix ? `${prefix} > ${node.name}` : node.name;
    out.push({ id: node.id, path });
    out.push(...flattenTaxonomy(node.children ?? [], path));
  }
  return out;
}

const sameValue = (a: FieldValue, b: FieldValue): boolean => sameState(a, b);

/** Which parts of a row's media grid differ from the listing as Etsy has it. */
function mediaChanges(listing: BulkListingDetail, state: ExistingMediaState | undefined) {
  if (!state) return { photos: false, videos: false };
  return gridChanges(
    mediaStateFromEtsy(listing),
    mediaStateFromGrid(state.order, state.altTextBySlot, state.videos, slotIdFor),
  );
}

const fieldLabel = (key: BulkFieldKey): string =>
  BULK_GROUPS.flatMap((g) => g.fields).find((f) => f.key === key)?.label ?? key;

/** Why an edited value can't be written to Etsy as it stands. */
function unwritableReason(field: BulkFieldKey): string {
  switch (field) {
    case "title":
      return "Etsy requires a title";
    case "tags":
    case "materials":
      return "Etsy's API documents no way to empty this list";
    case "taxonomyId":
      return "Etsy's API has no way to remove a listing's category";
    case "shopSectionId":
      return "Etsy's API documents no way to take a listing out of its section";
    case "price":
      return "Etsy needs a price greater than 0";
    case "quantity":
      return "Etsy needs a whole number of 0 or more";
    case "itemWeight":
    case "itemSize":
      return "Etsy needs a value greater than 0 with a unit, and documents no way to clear one";
    case "about":
      return "Etsy needs who made it, when, and what it is together";
    default:
      return "Etsy's API documents no way to clear this field";
  }
}

const newPhotoId = () => Math.random().toString(36).slice(2, 10);

const numberOr = (value: number | null, digits = 2): string =>
  value == null ? "" : digits > 0 ? value.toFixed(digits) : String(value);

/**
 * The bulk editor: every selected listing on its own row, each edited
 * individually, with an explicit per-field control for writing one value
 * across the ticked rows. Nothing reaches Etsy until Sync updates is pressed.
 */
interface InventoryResponse {
  inventories?: Record<string, VariationGrid>;
  variationImages?: Record<string, GridVariationImage[]>;
}

export default function BulkEditor({ listingIds }: { listingIds: number[] }) {
  const [listings, setListings] = useState<BulkListingDetail[] | null>(null);
  const toast = useToast();
  const [options, setOptions] = useState<BulkOptions>(EMPTY_OPTIONS);
  const [attributes, setAttributes] = useState<Record<number, ListingAttribute[]>>({});
  /** Each variation listing's grid as the variation form holds it, as Etsy has it now. */
  const [variationOriginals, setVariationOriginals] = useState<Record<number, ListingFormValue>>({});
  /** Edited variation forms, per listing. Absent means "untouched". */
  const [variationEdits, setVariationEdits] = useState<Record<number, ListingFormValue>>({});
  /**
   * Each listing's variation photos as Etsy has them. Absent: not read (the
   * block can't edit them); "unknown": a save's photo call failed after its
   * grid landed, so the next save sends the set whatever it is.
   */
  const [variationImageOriginals, setVariationImageOriginals] = useState<
    Record<number, BulkVariationImage[] | "unknown">
  >({});
  /** Listings whose inventory read has come back (with or without a grid). */
  const [inventoryDone, setInventoryDone] = useState<ReadonlySet<number>>(new Set());
  /** Variation blocks the user has expanded — each listing independently. */
  const [expandedBlocks, setExpandedBlocks] = useState<Record<number, boolean>>({});
  const [showVariationErrors, setShowVariationErrors] = useState(false);
  const [shopName, setShopName] = useState<string | null>(null);
  const [currencyCode, setCurrencyCode] = useState<string | null>(null);
  const [navOpen, setNavOpen] = useState(true);
  const [ai, setAi] = useState<AiSettings>({ preset: "", model: DEFAULT_AI_MODEL, prompt: "" });
  const [aiRunning, setAiRunning] = useState<Record<number, boolean>>({});
  const [aiErrors, setAiErrors] = useState<Record<number, string>>({});
  /**
   * What has already been asked for. A ref rather than state: it only guards
   * a fetch from being repeated, and nothing rendered reads it.
   */
  const requested = useRef({ attributes: false, inventories: new Set<number>(), taxonomies: new Set<number>() });

  const [selection, setSelection] = useState<FieldSelection>({
    group: BULK_GROUPS[0].key,
    field: BULK_GROUPS[0].fields[0].key,
  });
  const [search, setSearch] = useState("");
  /** Which listings a save writes to. Every selected listing starts included. */
  const [targeted, setTargeted] = useState<Record<number, boolean>>({});
  /** Edited values, per listing and field. Absent means "untouched". */
  const [edited, setEdited] = useState<Record<number, Partial<Record<BulkFieldKey, FieldValue>>>>({});
  const [saving, setSaving] = useState(false);
  /** How many of the run's listings have been written, while a Sync is going. */
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  /** The queued save job of the listing being synced, while it hasn't finished. */
  const [jobStatus, setJobStatus] = useState<JobView | null>(null);
  const [results, setResults] = useState<SaveResult[] | null>(null);
  /** The date/time picker, open while the user is scheduling this edit. */
  const [scheduling, setScheduling] = useState(false);
  /**
   * Each row's photo/video grid, once it has been touched. Local only — a
   * listing's media is written by Sync updates and nothing else.
   */
  const [media, setMedia] = useState<Record<number, ExistingMediaState>>({});
  const [mediaErrors, setMediaErrors] = useState<Record<number, string | null>>({});

  const idsKey = listingIds.join(",");
  const field = selection.field;

  useEffect(() => {
    if (listingIds.length === 0) {
      setListings([]);
      return;
    }
    const controller = new AbortController();
    fetch(`/api/etsy/listings/bulk?ids=${idsKey}`, { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error(await errorFrom(res));
        return (await res.json()) as { listings: BulkListingDetail[]; missing: number[] };
      })
      .then((body) => {
        if (controller.signal.aborted) return;
        setListings(body.listings);
        const missing = body.missing ?? [];
        if (missing.length > 0) {
          toast.show({
            id: "bulk-missing",
            kind: "error",
            message: `${missing.length} selected listing${missing.length === 1 ? "" : "s"} could not be loaded and ${
              missing.length === 1 ? "is" : "are"
            } not shown. Refresh the shop and try again.`,
          });
        }
        setTargeted(Object.fromEntries(body.listings.map((l) => [l.listingId, true])));
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setListings([]);
        toast.show({
          id: "bulk-load-error",
          kind: "error",
          message: err instanceof Error ? err.message : "Failed to load the selected listings.",
        });
      });
    return () => controller.abort();
  }, [idsKey, listingIds.length, toast]);

  // The option lists every dropdown draws on. Each is independent — one
  // failing (a shop with no return policies, say) leaves the rest usable.
  useEffect(() => {
    const load = <T,>(url: string, pick: (body: Record<string, unknown>) => T, apply: (value: T) => void) => {
      fetch(url)
        .then((res) => (res.ok ? res.json() : null))
        .then((body: Record<string, unknown> | null) => {
          if (body) apply(pick(body));
        })
        .catch(() => {});
    };
    load("/api/etsy/sections", (b) => (b.sections ?? []) as BulkOptions["sections"], (sections) =>
      setOptions((prev) => ({ ...prev, sections })),
    );
    load("/api/etsy/shipping-profiles", (b) => (b.profiles ?? []) as BulkOptions["shippingProfiles"], (shippingProfiles) =>
      setOptions((prev) => ({ ...prev, shippingProfiles })),
    );
    load("/api/etsy/processing-profiles", (b) => (b.profiles ?? []) as BulkOptions["processingProfiles"], (processingProfiles) =>
      setOptions((prev) => ({ ...prev, processingProfiles })),
    );
    load("/api/etsy/return-policies", (b) => (b.policies ?? []) as BulkOptions["returnPolicies"], (returnPolicies) =>
      setOptions((prev) => ({ ...prev, returnPolicies })),
    );
    load("/api/etsy/production-partners", (b) => (b.partners ?? []) as BulkOptions["productionPartners"], (productionPartners) =>
      setOptions((prev) => ({ ...prev, productionPartners })),
    );
    load("/api/etsy/taxonomy", (b) => flattenTaxonomy((b.tree ?? []) as TaxonomyNode[]), (taxonomy) =>
      setOptions((prev) => ({ ...prev, taxonomy })),
    );
    load("/api/etsy/shop", (b) => b as { shopName?: string; currencyCode?: string | null }, (shop) => {
      setShopName(shop.shopName ?? null);
      setCurrencyCode(shop.currencyCode ?? null);
    });
  }, []);

  // Attributes cost one Etsy call per listing, so they're only fetched once
  // the Optional group is actually opened.
  const attributeFieldSelected = isAttributeField(field);
  useEffect(() => {
    if (!attributeFieldSelected || requested.current.attributes) return;
    if (listings == null || listings.length === 0) return;
    requested.current.attributes = true;
    fetch(`/api/etsy/listings/bulk/attributes?ids=${idsKey}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((body: { attributes?: Record<string, ListingAttribute[]> } | null) => {
        const raw = body?.attributes ?? {};
        setAttributes(
          Object.fromEntries(Object.entries(raw).map(([id, list]) => [Number(id), list])),
        );
      })
      .catch(() => {});
  }, [attributeFieldSelected, listings, idsKey]);

  // Each distinct category in the selection has its own property list — that's
  // what makes an attribute's valid values row-specific.
  const taxonomyIdsKey = useMemo(
    () => [...new Set((listings ?? []).map((l) => l.taxonomyId).filter((id): id is number => id != null))].join(","),
    [listings],
  );
  const variationFieldSelected = VARIATION_FIELDS.has(field);
  useEffect(() => {
    if (!(attributeFieldSelected || variationFieldSelected) || !taxonomyIdsKey) return;
    for (const raw of taxonomyIdsKey.split(",")) {
      const taxonomyId = Number(raw);
      if (requested.current.taxonomies.has(taxonomyId)) continue;
      requested.current.taxonomies.add(taxonomyId);
      fetch(`/api/etsy/taxonomy/${taxonomyId}/properties`)
        .then((res) => (res.ok ? res.json() : null))
        .then((body: { properties?: TaxonomyProperty[] } | null) => {
          setOptions((current) => ({
            ...current,
            propertiesByTaxonomy: {
              ...current.propertiesByTaxonomy,
              [taxonomyId]: body?.properties ?? [],
            },
          }));
        })
        .catch(() => {});
    }
  }, [attributeFieldSelected, variationFieldSelected, taxonomyIdsKey]);

  // Variation grids cost one Etsy call per listing too: read when a variation-aware
  // field is opened, and only for the listings that field shows a block for.
  useEffect(() => {
    if (!variationFieldSelected || listings == null) return;
    const needed = listings
      .filter((l) => (field === "variations" || l.hasVariations) && !requested.current.inventories.has(l.listingId))
      .map((l) => l.listingId);
    if (needed.length === 0) return;
    for (const id of needed) requested.current.inventories.add(id);
    fetch(`/api/etsy/listings/bulk/inventory?ids=${needed.join(",")}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((body: InventoryResponse | null) => {
        const forms: Record<number, ListingFormValue> = {};
        const images: Record<number, BulkVariationImage[]> = {};
        for (const [raw, grid] of Object.entries(body?.inventories ?? {})) {
          const listing = listings.find((l) => l.listingId === Number(raw));
          if (!listing) continue;
          // A listing without variations can't have variation photos, so it needs no read.
          const read = grid.properties.length === 0 ? [] : body?.variationImages?.[raw];
          const form: ListingFormValue = { ...EMPTY_LISTING_FORM, ...gridToOfferingState(grid, listing, read ?? []) };
          forms[listing.listingId] = form;
          if (read) images[listing.listingId] = offeringStateToVariationImages(form);
        }
        setVariationOriginals((prev) => ({ ...prev, ...forms }));
        setVariationImageOriginals((prev) => ({ ...prev, ...images }));
      })
      .catch(() => {})
      // Only once the read is back does a block stop saying "Loading…".
      .finally(() => setInventoryDone((prev) => new Set([...prev, ...needed])));
  }, [variationFieldSelected, field, listings]);

  /** The listing's own stored value for `field`, as the inputs represent it. */
  const originalValue = useCallback(
    (listing: BulkListingDetail, key: BulkFieldKey): FieldValue => {
      switch (key) {
        case "title":
          return listing.title;
        case "description":
          return listing.description;
        case "tags":
          return listing.tags;
        case "materials":
          return listing.materials;
        case "about":
          return {
            whoMade: listing.whoMade,
            whenMade: listing.whenMade,
            isSupply: listing.isSupply,
            productionPartnerIds: listing.productionPartnerIds,
          } satisfies AboutValue;
        case "productionPartners":
          return listing.productionPartnerIds.map(String);
        case "personalization":
          return listing.personalizationQuestions;
        case "taxonomyId":
          return listing.taxonomyId == null ? "" : String(listing.taxonomyId);
        case "shopSectionId":
          return listing.shopSectionId == null ? "" : String(listing.shopSectionId);
        case "shippingProfileId":
          return listing.shippingProfileId == null ? "" : String(listing.shippingProfileId);
        case "returnPolicyId":
          return listing.returnPolicyId == null ? "" : String(listing.returnPolicyId);
        case "readinessStateId":
          return listing.readinessStateId == null ? "" : String(listing.readinessStateId);
        case "price":
          return numberOr(listing.price);
        case "quantity":
          return String(listing.quantity);
        case "sku":
          return listing.sku;
        case "itemWeight":
          return {
            weight: numberOr(listing.itemWeight),
            unit: listing.itemWeightUnit ?? "",
          } satisfies WeightValue;
        case "itemSize":
          return {
            length: numberOr(listing.itemLength),
            width: numberOr(listing.itemWidth),
            height: numberOr(listing.itemHeight),
            unit: listing.itemDimensionsUnit ?? "",
          } satisfies SizeValue;
        case "photos":
        case "videos":
        case "variations":
          return "";
        default: {
          if (!isAttributeField(key)) return "";
          const property = propertyForListing(key, listing, options);
          if (!property) return { propertyId: 0, valueIds: [], values: [], scaleId: null } satisfies AttributeValue;
          const current = (attributes[listing.listingId] ?? []).find(
            (a) => a.propertyId === property.propertyId,
          );
          return {
            propertyId: property.propertyId,
            valueIds: current?.valueIds ?? [],
            values: current?.values ?? [],
            scaleId: current?.scaleId ?? null,
          } satisfies AttributeValue;
        }
      }
    },
    [attributes, options],
  );

  const valueOf = useCallback(
    (listing: BulkListingDetail, key: BulkFieldKey): FieldValue =>
      edited[listing.listingId]?.[key] ?? originalValue(listing, key),
    [edited, originalValue],
  );

  function setValue(listingId: number, key: BulkFieldKey, value: FieldValue) {
    setEdited((prev) => ({ ...prev, [listingId]: { ...prev[listingId], [key]: value } }));
  }

  /** Can this listing take an edit to this field at all? */
  const editable = useCallback(
    (listing: BulkListingDetail, key: BulkFieldKey): boolean => {
      if (isReadOnlyField(key)) return false;
      // A variation listing prices, stocks and schedules each combination on its variation block.
      if ((INVENTORY_LOCKED.has(key) || key === "readinessStateId") && listing.hasVariations) return false;
      return true;
    },
    [],
  );

  const variationFormFor = (listing: BulkListingDetail): ListingFormValue | null =>
    variationEdits[listing.listingId] ?? variationOriginals[listing.listingId] ?? null;

  /** Merge an edit into one listing's variation form. */
  function editVariations(listingId: number, partial: Partial<ListingFormValue>) {
    setVariationEdits((prev) => {
      const base = prev[listingId] ?? variationOriginals[listingId];
      return base ? { ...prev, [listingId]: { ...base, ...partial } } : prev;
    });
  }

  /** Does this row show its variation block for the current field? */
  const showsBlock = (listing: BulkListingDetail) =>
    VARIATION_FIELDS.has(field) && (field === "variations" || listing.hasVariations);

  /** What an inventory instruction means for a variation form — null when it can't apply there. */
  function resolveFormInstruction(
    instruction: ApplyInstruction,
    form: ListingFormValue,
  ): Partial<ListingFormValue> | null {
    if (instruction.kind === "numeric" && (field === "price" || field === "quantity")) {
      return applyNumericToForm(form, field, instruction.instruction);
    }
    if (instruction.kind === "sku") return applySkuToForm(form, instruction.position, instruction.text);
    if (instruction.kind === "set" && field === "readinessStateId") {
      return applyProcessingToForm(form, Number(instruction.value));
    }
    return null;
  }

  /** Write one instruction into every ticked listing — the explicit apply-to-all. */
  function applyToTicked(instruction: ApplyInstruction) {
    const formEdits: Record<number, ListingFormValue> = {};
    for (const listing of listings ?? []) {
      if (!targeted[listing.listingId] || !showsBlock(listing)) continue;
      const form = variationFormFor(listing);
      const partial = form && resolveFormInstruction(instruction, form);
      if (form && partial) formEdits[listing.listingId] = { ...form, ...partial };
    }
    if (Object.keys(formEdits).length > 0) setVariationEdits((prev) => ({ ...prev, ...formEdits }));

    setEdited((prev) => {
      const next = { ...prev };
      for (const listing of listings ?? []) {
        if (!targeted[listing.listingId] || !editable(listing, field) || showsBlock(listing)) continue;
        const current = next[listing.listingId]?.[field] ?? originalValue(listing, field);
        const resolved = resolveInstruction(instruction, listing, current);
        if (resolved === null) continue;
        next[listing.listingId] = { ...next[listing.listingId], [field]: resolved };
      }
      return next;
    });
  }

  /** What one instruction means for one row — null when it can't apply there. */
  function resolveInstruction(
    instruction: ApplyInstruction,
    listing: BulkListingDetail,
    current: FieldValue,
  ): FieldValue | null {
    switch (instruction.kind) {
      case "transform":
        return applyTextTransform(String(current), instruction);
      case "append": {
        const list = Array.isArray(current) ? (current as string[]) : [];
        return field === "tags"
          ? appendToList(list, instruction.value, { max: MAX_TAGS, trimTo: MAX_TAG_LENGTH })
          : appendToList(list, instruction.value, { max: MAX_MATERIALS, trimTo: MAX_MATERIAL_LENGTH });
      }
      case "numeric":
        return field === "price" || field === "quantity"
          ? applyNumericToValue(field, String(current), instruction.instruction)
          : null;
      case "sku":
        return applySkuText(String(current), instruction.position, instruction.text);
      case "attribute": {
        // Matched by name: the same value (and scale) has a different id on each category.
        const property = propertyForListing(field, listing, options);
        if (!property) return null;
        const scaleName = (scaleId: number | null) =>
          property.scales.find((scale) => scale.scaleId === scaleId)?.displayName ?? null;
        const picked = property.possibleValues.find(
          (v) =>
            v.valueId != null &&
            v.name === instruction.valueName &&
            (instruction.scaleName == null || scaleName(v.scaleId) === instruction.scaleName),
        );
        if (!picked || picked.valueId == null) return null;
        return {
          propertyId: property.propertyId,
          valueIds: [picked.valueId],
          values: [picked.name],
          scaleId: picked.scaleId,
        } satisfies AttributeValue;
      }
      case "about": {
        const about = current as AboutValue;
        return {
          ...about,
          whoMade: instruction.whoMade,
          whenMade: instruction.whenMade,
          isSupply: instruction.isSupply,
        } satisfies AboutValue;
      }
      case "partners":
        return instruction.ids.map(String);
      case "weight":
        return { weight: instruction.weight, unit: instruction.unit } satisfies WeightValue;
      case "size":
        return {
          length: instruction.length,
          width: instruction.width,
          height: instruction.height,
          unit: instruction.unit,
        } satisfies SizeValue;
      case "set":
        return instruction.value;
    }
  }

  /** The patch that would be written to one listing: only fields actually changed. */
  const patchFor = useCallback(
    (listing: BulkListingDetail): BulkListingPatch => {
      const patch: BulkListingPatch = {};
      const rowEdits = edited[listing.listingId];
      if (!rowEdits) return patch;

      const attributeEntries: BulkAttributeValue[] = [];
      for (const [key, value] of Object.entries(rowEdits) as [BulkFieldKey, FieldValue][]) {
        if (!editable(listing, key)) continue;
        if (sameValue(value, originalValue(listing, key))) continue;

        if (isAttributeField(key)) {
          const attribute = value as AttributeValue;
          if (attribute.propertyId > 0 && attribute.valueIds.length > 0) {
            attributeEntries.push({
              propertyId: attribute.propertyId,
              valueIds: attribute.valueIds,
              values: attribute.values,
              scaleId: attribute.scaleId,
            });
          }
          continue;
        }
        Object.assign(patch, patchEntry(key, value) ?? {});
      }
      if (attributeEntries.length > 0) patch.attributes = attributeEntries;
      return patch;
    },
    [edited, editable, originalValue],
  );

  /** A listing's replacement variation grid, when its form differs from Etsy's. */
  const variationPatchFor = useCallback(
    (listing: BulkListingDetail): BulkListingPatch["variations"] | null => {
      const edit = variationEdits[listing.listingId];
      const original = variationOriginals[listing.listingId];
      if (!edit || !original) return null;
      const next = offeringStateToBulkVariations(edit);
      return next && JSON.stringify(next) !== JSON.stringify(offeringStateToBulkVariations(original)) ? next : null;
    },
    [variationEdits, variationOriginals],
  );

  /**
   * A listing's full set of variation photos, when it has to be sent: it
   * differs from Etsy's, or the grid is being replaced and photos are
   * assigned (so they're re-attached to the values the replace leaves).
   */
  const variationImagesPatchFor = useCallback(
    (listing: BulkListingDetail, gridReplaced: boolean): BulkVariationImage[] | null => {
      const edit = variationEdits[listing.listingId];
      const original = variationImageOriginals[listing.listingId];
      if (!edit || original === undefined) return null;
      const next = offeringStateToVariationImages(edit);
      if (original === "unknown" || JSON.stringify(next) !== JSON.stringify(original)) return next;
      return gridReplaced && next.length > 0 ? next : null;
    },
    [variationEdits, variationImageOriginals],
  );

  const fullPatchFor = useCallback(
    (listing: BulkListingDetail): BulkListingPatch => {
      const patch = patchFor(listing);
      const variations = variationPatchFor(listing);
      const variationImages = variationImagesPatchFor(listing, variations != null);
      return {
        ...patch,
        ...(variations ? { variations } : {}),
        ...(variationImages ? { variationImages } : {}),
      };
    },
    [patchFor, variationPatchFor, variationImagesPatchFor],
  );

  /** Edits on a row that Etsy's API can't write — reported, never dropped. */
  const unsyncedFor = useCallback(
    (listing: BulkListingDetail): (UnsyncedChange & { key: string })[] => {
      const out: (UnsyncedChange & { key: string })[] = [];
      for (const [key, value] of Object.entries(edited[listing.listingId] ?? {}) as [BulkFieldKey, FieldValue][]) {
        if (sameValue(value, originalValue(listing, key))) continue;
        const field = fieldLabel(key);
        if (!editable(listing, key)) {
          if (!isReadOnlyField(key)) {
            out.push({ key, field, reason: "this listing has variations, so it is edited on its Variations block" });
          }
          continue;
        }
        if (isAttributeField(key)) {
          const attribute = value as AttributeValue;
          if (attribute.propertyId > 0 && attribute.valueIds.length > 0) continue;
          out.push({
            key,
            field,
            reason:
              attribute.propertyId > 0
                ? "Etsy's API documents no way to clear a category attribute"
                : "this listing's category has no such attribute",
          });
          continue;
        }
        if (!patchEntry(key, value)) out.push({ key, field, reason: unwritableReason(key) });
      }
      const edit = variationEdits[listing.listingId];
      const original = variationOriginals[listing.listingId];
      if (edit && original && !sameState(edit, original) && !offeringStateToBulkVariations(edit)) {
        out.push({ key: "variations", field: "Variations", reason: "a listing's last variation can't be removed from here" });
      }
      return out;
    },
    [edited, editable, originalValue, variationEdits, variationOriginals],
  );

  const updates = useMemo(() => {
    return (listings ?? [])
      .filter((l) => targeted[l.listingId])
      .map((l) => ({ listingId: l.listingId, patch: fullPatchFor(l), unsynced: unsyncedFor(l) }))
      .filter((u) => Object.keys(u.patch).length > 0 || u.unsynced.length > 0);
  }, [listings, targeted, fullPatchFor, unsyncedFor]);

  /** Ticked listings whose photo/video grid would change on save. */
  const mediaUpdates = useMemo(
    () =>
      (listings ?? []).filter((l) => {
        if (!targeted[l.listingId]) return false;
        const changed = mediaChanges(l, media[l.listingId]);
        return changed.photos || changed.videos;
      }),
    [listings, targeted, media],
  );
  const syncCount = new Set([
    ...updates.map((u) => u.listingId),
    ...mediaUpdates.map((l) => l.listingId),
  ]).size;

  /** Listings, ticked or not, with an edit that no Sync has written yet. */
  const unsavedCount = (listings ?? []).filter((l) => {
    if (Object.keys(fullPatchFor(l)).length > 0 || unsyncedFor(l).length > 0) return true;
    const changed = mediaChanges(l, media[l.listingId]);
    return changed.photos || changed.videos;
  }).length;
  const { dialog: unsavedDialog } = useUnsavedChangesGuard(unsavedCount, {
    onSave: () => save(),
    saveLabel: "Sync updates and leave",
  });

  const mediaFor = (listing: BulkListingDetail) => media[listing.listingId] ?? initialExistingMedia(listing);

  /** The photos a variation value can show: those already on the listing, in the grid's order. */
  const variationPhotoSlots = (listing: BulkListingDetail) =>
    mediaPhotoSlots(mediaFor(listing), listing)
      .filter((slot) => slot.ref.kind === "etsy")
      .map((slot) => ({ slotId: slot.slotId, thumbnailUrl: slot.thumbnailUrl, label: slot.label }));

  function updateMedia(listing: BulkListingDetail, change: (state: ExistingMediaState) => ExistingMediaState) {
    setMedia((prev) => ({
      ...prev,
      [listing.listingId]: change(prev[listing.listingId] ?? initialExistingMedia(listing)),
    }));
  }

  function removePhoto(listing: BulkListingDetail, slotId: string) {
    const { state, removed } = removeMediaPhoto(mediaFor(listing), slotId);
    if (removed) URL.revokeObjectURL(removed.url);
    setMedia((prev) => ({ ...prev, [listing.listingId]: state }));
  }

  function addPhotos(listing: BulkListingDetail, files: File[]) {
    const { state, errors } = addMediaPhotos(mediaFor(listing), files, (file) => ({
      id: newPhotoId(),
      file,
      url: URL.createObjectURL(file),
    }));
    setMedia((prev) => ({ ...prev, [listing.listingId]: state }));
    setMediaErrors((prev) => ({ ...prev, [listing.listingId]: errors.length > 0 ? errors.join(" ") : null }));
  }

  async function selectVideo(listing: BulkListingDetail, slot: number, file: File | null) {
    const error = file ? await checkPickedVideo(file) : null;
    updateMedia(listing, (state) => setMediaVideo(state, slot, file, error));
  }

  /** Forget a row's grid edits, releasing the previews of photos added to it. */
  function resetMedia(listingId: number) {
    setMedia((prev) => {
      for (const added of prev[listingId]?.added ?? []) URL.revokeObjectURL(added.url);
      const next = { ...prev };
      delete next[listingId];
      return next;
    });
  }

  /** How many listings have a pending change per field, for the sidebar badges. */
  const pendingByField = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const listing of listings ?? []) {
      if (!targeted[listing.listingId]) continue;
      for (const [key, value] of Object.entries(edited[listing.listingId] ?? {}) as [
        BulkFieldKey,
        FieldValue,
      ][]) {
        if (!editable(listing, key)) continue;
        if (sameValue(value, originalValue(listing, key))) continue;
        counts[key] = (counts[key] ?? 0) + 1;
      }
      const changed = mediaChanges(listing, media[listing.listingId]);
      if (changed.photos) counts.photos = (counts.photos ?? 0) + 1;
      if (changed.videos) counts.videos = (counts.videos ?? 0) + 1;
      if (variationPatchFor(listing)) counts.variations = (counts.variations ?? 0) + 1;
    }
    return counts;
  }, [listings, edited, targeted, editable, originalValue, media, variationPatchFor]);

  const visible = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const all = listings ?? [];
    return needle ? all.filter((l) => l.title.toLowerCase().includes(needle)) : all;
  }, [listings, search]);

  const targetedCount = (listings ?? []).filter((l) => targeted[l.listingId]).length;

  /** Write one listing's photo/video grid. */
  async function saveListingMedia(listing: BulkListingDetail): Promise<SaveResult> {
    const id = listing.listingId;
    try {
      const res = await writeWithTimeout(`/api/etsy/listings/${id}/media`, {
        method: "POST",
        body: mediaSaveForm(mediaFor(listing)),
      });
      if (!res.ok) throw new Error(await errorFrom(res));
      const body = (await res.json()) as {
        ok: boolean;
        failed: { name: string; error: string }[];
        images: BulkListingDetail["images"] | null;
        videos: BulkListingDetail["videos"] | null;
      };
      if (body.images && body.videos) {
        const images = body.images;
        const videos = body.videos;
        setListings((prev) =>
          (prev ?? []).map((l) =>
            l.listingId === id ? { ...l, images, videos, thumbnailUrl: images[0]?.url ?? l.thumbnailUrl } : l,
          ),
        );
        resetMedia(id);
      }
      return body.ok
        ? { listingId: id, ok: true }
        : { listingId: id, ok: false, error: body.failed.map((f) => `${f.name}: ${f.error}`).join("; ") };
    } catch (err) {
      return { listingId: id, ok: false, error: err instanceof Error ? err.message : "Save failed." };
    }
  }

  /** Write one listing's field patch, and fold what landed back into its row. */
  async function saveListingFields(update: {
    listingId: number;
    patch: BulkListingPatch;
    unsynced: (UnsyncedChange & { key: string })[];
  }): Promise<SaveResult> {
    const id = update.listingId;
    const notSynced: SaveResult | null =
      update.unsynced.length > 0 ? { listingId: id, ok: false, error: describeUnsynced(update.unsynced) } : null;
    if (Object.keys(update.patch).length === 0) return notSynced!;
    // A variation grid with errors is refused for that listing only — the rest still go out.
    const listing = (listings ?? []).find((l) => l.listingId === id);
    const form = update.patch.variations || update.patch.variationImages ? variationEdits[id] : undefined;
    const slotIds = listing ? variationPhotoSlots(listing).map((slot) => slot.slotId) : [];
    const invalid = form ? validateOfferings(form, slotIds)[0] : undefined;
    if (invalid) {
      setShowVariationErrors(true);
      setExpandedBlocks((prev) => ({ ...prev, [id]: true }));
      return { listingId: id, ok: false, error: `Variations: ${invalid.message}` };
    }

    const result = await syncListingPatch(id, update.patch, setJobStatus);
    setJobStatus(null);
    if (!result.ok && !result.partial) return notSynced ? mergeResults(id, [result, notSynced]) : result;

    // Saved values are now the listing's own values — clear the edits that
    // landed so the row stops showing them as pending. Failed rows keep theirs.
    // A partial save landed everything but the variation photos: those
    // selections stay in the form so the next Sync sends them again.
    // The listing-side fields come from Etsy's own response (`confirmed`), so
    // the row can never show a list Etsy didn't store; the patch only fills in
    // what that response doesn't carry (price, quantity, SKU, personalization).
    setListings((prev) =>
      (prev ?? []).map((l) => {
        if (l.listingId !== id) return l;
        const saved = applySaved(l, patchFor(l));
        const next = result.confirmed ? applyConfirmed(saved, result.confirmed) : saved;
        return form ? { ...next, hasVariations: form.variations.length > 0 } : next;
      }),
    );
    // Edits Etsy couldn't take stay on the row, still pending and still reported.
    const keep = new Set(update.unsynced.map((u) => u.key));
    setEdited((prev) => {
      const next = { ...prev };
      const kept = Object.fromEntries(Object.entries(prev[id] ?? {}).filter(([key]) => keep.has(key)));
      if (Object.keys(kept).length > 0) next[id] = kept as (typeof prev)[number];
      else delete next[id];
      return next;
    });
    if (form) setVariationOriginals((prev) => ({ ...prev, [id]: form }));
    const images = update.patch.variationImages;
    if (images) setVariationImageOriginals((prev) => ({ ...prev, [id]: result.ok ? images : "unknown" }));
    if (form && result.ok) {
      setVariationEdits((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
    }
    return notSynced ? mergeResults(id, [result, { ...notSynced, partial: true }]) : result;
  }

  /**
   * Write every ticked listing, one at a time, so a slow or dead request costs
   * that listing only: each write is abandoned after 30 s and reported as a
   * failure while the run carries on. Progress is counted per listing, and the
   * run always ends — the buttons can't be left stuck in the syncing state.
   */
  async function save(): Promise<boolean> {
    const mediaIds = new Set(mediaUpdates.map((l) => l.listingId));
    const runIds = [...new Set([...mediaIds, ...updates.map((u) => u.listingId)])];
    setSaving(true);
    setProgress({ done: 0, total: runIds.length });
    setResults(null);
    toast.dismiss("bulk-results");
    const done: SaveResult[] = [];
    try {
      for (const id of runIds) {
        const listing = (listings ?? []).find((l) => l.listingId === id);
        const steps: SaveResult[] = [];
        // Media goes first for each listing: variation photos can only name
        // photos already on the listing, and are checked against the listing's
        // photos as they are once its media has landed.
        if (listing && mediaIds.has(id)) steps.push(await saveListingMedia(listing));
        const update = updates.find((u) => u.listingId === id);
        if (update) steps.push(await saveListingFields(update));
        done.push(mergeResults(id, steps));
        setProgress({ done: done.length, total: runIds.length });
      }
    } catch (err) {
      toast.show({ id: "bulk-save-error", kind: "error", message: err instanceof Error ? err.message : "Save failed." });
    } finally {
      setResults(done);
      if (done.length > 0) {
        toast.show({
          id: "bulk-results",
          kind: done.some((r) => !r.ok) ? "error" : "success",
          message: <SaveResultsMessage results={done} listings={listings ?? []} />,
        });
      }
      // If anything failed, only the failures stay ticked, so a second Sync
      // retries those alone. A run where everything landed leaves the ticks be.
      const written = new Set(done.filter((r) => r.ok).map((r) => r.listingId));
      if (done.some((r) => !r.ok)) {
        setTargeted((prev) =>
          Object.fromEntries(Object.entries(prev).map(([id, on]) => [id, on && !written.has(Number(id))])),
        );
      }
      setProgress(null);
      setSaving(false);
    }
    return done.length > 0 && done.every((r) => r.ok);
  }


  /**
   * Store every pending change as a scheduled job instead of writing it now.
   * Files the edit adds are uploaded to the job's own storage prefix first —
   * the runner has no browser to read them from — and the job records which
   * listings it covers, so it can report per listing exactly as Sync updates
   * does. Nothing reaches Etsy here.
   */
  async function scheduleEdits(input: ScheduleTimeInput): Promise<string | null> {
    const ids = [...new Set([...updates.map((u) => u.listingId), ...mediaUpdates.map((l) => l.listingId)])];
    if (ids.length === 0) return "There are no changes to schedule.";
    // A scheduled job can only hold what Etsy's API can write; anything else is named, not dropped.
    const blocked = updates.find((u) => u.unsynced.length > 0);
    if (blocked) {
      const title = (listings ?? []).find((l) => l.listingId === blocked.listingId)?.title ?? `Listing ${blocked.listingId}`;
      return `${title}: ${describeUnsynced(blocked.unsynced)} Undo that edit to schedule the rest.`;
    }

    const setId = crypto.randomUUID();
    const payload: ScheduledBulkUpdate[] = [];
    for (const id of ids) {
      const listing = (listings ?? []).find((l) => l.listingId === id);
      if (!listing) continue;
      const patch = updates.find((u) => u.listingId === id)?.patch ?? {};

      // The same refusal a save makes: a grid with errors is never stored.
      const form = patch.variations || patch.variationImages ? variationEdits[id] : undefined;
      const invalid = form ? validateOfferings(form, variationPhotoSlots(listing).map((s) => s.slotId))[0] : undefined;
      if (invalid) {
        setShowVariationErrors(true);
        setExpandedBlocks((prev) => ({ ...prev, [id]: true }));
        return `${listing.title}: ${invalid.message}`;
      }

      let media: ScheduledBulkUpdate["media"];
      if (mediaUpdates.some((l) => l.listingId === id)) {
        const { payload: order, imageFiles, videoFiles } = mediaSavePayload(mediaFor(listing));
        try {
          media = {
            images: order.images as ScheduledImageEntry[],
            videos: order.videos as ScheduledVideoEntry[],
            imageFiles: await Promise.all(imageFiles.map((file, i) => storeScheduledFile(setId, id, "image", i, file))),
            videoFiles: await Promise.all(videoFiles.map((file, i) => storeScheduledFile(setId, id, "video", i, file))),
          };
        } catch (err) {
          return err instanceof Error ? err.message : "The added photos could not be stored.";
        }
      }

      payload.push({ listingId: id, title: listing.title, patch, ...(media ? { media } : {}) });
    }

    let when: string;
    try {
      const res = await fetch("/api/schedule", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "bulk_edit", ...input, setId, updates: payload }),
      });
      if (!res.ok) throw new Error(await errorFrom(res));
      const body = (await res.json()) as { scheduledListing: { scheduledAt: string } };
      when = new Date(body.scheduledListing.scheduledAt).toLocaleString();
    } catch (err) {
      return err instanceof Error ? err.message : "The edits could not be scheduled.";
    }

    // The edits now live on the scheduled job, so the screen holds nothing
    // unsaved — no warning fires on the way out.
    setMedia((prev) => {
      for (const state of Object.values(prev)) for (const added of state.added) URL.revokeObjectURL(added.url);
      return {};
    });
    setEdited({});
    setVariationEdits({});
    setResults(null);
    toast.show({
      id: "bulk-scheduled",
      kind: "success",
      message: (
        <>
          Scheduled {payload.length} listing{payload.length === 1 ? "" : "s"} for {when}. Nothing has been sent to Etsy
          — the changes are applied then.{" "}
          <Link href="/schedule" className="font-medium text-primary underline underline-offset-2">
            See scheduled listings
          </Link>
        </>
      ),
    });
    setScheduling(false);
    return null;
  }

  /** Ask Claude for a new value of the AI field for one listing, filling its row. */
  async function regenerate(listing: BulkListingDetail) {
    const id = listing.listingId;
    const target = field as AiField;
    setAiRunning((prev) => ({ ...prev, [id]: true }));
    setAiErrors((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
    try {
      const res = await fetch("/api/ai/optimize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          field: target,
          model: ai.model,
          preset: ai.preset,
          prompt: ai.prompt,
          listing: {
            title: String(valueOf(listing, "title")),
            description: String(valueOf(listing, "description")),
            tags: valueOf(listing, "tags") as string[],
          },
        }),
      });
      if (!res.ok) throw new Error(await errorFrom(res));
      const body = (await res.json()) as { value: string | string[] };
      setValue(id, target, body.value);
    } catch (err) {
      setAiErrors((prev) => ({ ...prev, [id]: err instanceof Error ? err.message : "AI Edits failed." }));
    } finally {
      setAiRunning((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
    }
  }

  /** Optimize: every ticked row, a few at a time. */
  async function optimizeTicked() {
    const queue = (listings ?? []).filter((l) => targeted[l.listingId]);
    const worker = async () => {
      for (let next = queue.shift(); next; next = queue.shift()) await regenerate(next);
    };
    await Promise.all(Array.from({ length: Math.min(AI_CONCURRENCY, queue.length) }, worker));
  }

  const masterRef = useRef<HTMLInputElement>(null);
  const visibleTargeted = visible.filter((l) => targeted[l.listingId]).length;
  const allVisibleTargeted = visible.length > 0 && visibleTargeted === visible.length;
  useEffect(() => {
    if (masterRef.current) masterRef.current.indeterminate = visibleTargeted > 0 && !allVisibleTargeted;
  }, [visibleTargeted, allVisibleTargeted]);

  const resultFor = (listingId: number) => results?.find((r) => r.listingId === listingId);
  const count = (listings ?? []).length;
  const label = labelFor(field);
  const aiField = selection.group === "ai";
  const showApplyControl = !aiField && applyKindFor(field) !== "none" && !isReadOnlyField(field);
  const aiUsable = isUsableAiSettings(ai);
  const aiRunningCount = Object.keys(aiRunning).length;
  const currencySymbol = currencyCode ? symbolFor(currencyCode) : "$";

  function renderRow(listing: BulkListingDetail) {
    const id = listing.listingId;
    const result = resultFor(id);
    const rowPatch = fullPatchFor(listing);
    const rowMedia = mediaChanges(listing, media[id]);
    const changed = Object.keys(rowPatch).length + (rowMedia.photos ? 1 : 0) + (rowMedia.videos ? 1 : 0);
    const rowMediaState = mediaFor(listing);
    const properties = listing.taxonomyId == null ? [] : options.propertiesByTaxonomy[listing.taxonomyId];
    return (
      <div
        role="group"
        aria-label={listing.title}
        className="rounded-xl border border-black/10 bg-white p-4 dark:border-white/15 dark:bg-zinc-950"
      >
        <div className="flex items-start gap-3">
          <input
            type="checkbox"
            aria-label={`Include ${listing.title} in the save`}
            checked={targeted[id] ?? false}
            onChange={(e) => setTargeted((p) => ({ ...p, [id]: e.target.checked }))}
            className="mt-1 h-4 w-4 cursor-pointer accent-primary"
          />
          <span className="flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded bg-zinc-100 dark:bg-zinc-800">
            {listing.thumbnailUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={listing.thumbnailUrl} alt="" className="h-full w-full object-cover" />
            ) : (
              <span className="text-[13px] text-zinc-400">—</span>
            )}
          </span>
          <div className="min-w-0 flex-1">
            <p className="break-words text-sm font-medium text-zinc-800 dark:text-zinc-100">{listing.title}</p>
            <p className="text-xs text-zinc-500">
              {listing.state}
              {changed > 0 && ` · ${changed} change${changed === 1 ? "" : "s"} pending`}
              {result && !result.ok && (
                <span className="text-red-600 dark:text-red-400">
                  {" "}
                  · {result.partial && "Partly saved. "}
                  {result.error}
                </span>
              )}
              {result?.ok && <span className="text-green-700 dark:text-green-400"> · saved</span>}
            </p>
          </div>
          {aiField && (
            <button
              type="button"
              onClick={() => void regenerate(listing)}
              disabled={!aiUsable || aiRunning[id]}
              aria-label={`Regenerate ${label.toLowerCase()} for ${listing.title}`}
              title={aiUsable ? undefined : "Choose a preset or write a prompt above first"}
              className="h-8 shrink-0 rounded-full border border-black/10 px-3 text-xs font-medium hover:bg-black/[.04] disabled:cursor-not-allowed disabled:opacity-40 dark:border-white/15 dark:hover:bg-white/[.06]"
            >
              {aiRunning[id] ? "Generating…" : "↻ Regenerate"}
            </button>
          )}
        </div>

        <div className="mt-3 pl-7">
          {aiField && aiErrors[id] && (
            <p role="alert" className="mb-2 text-xs font-medium text-red-600 dark:text-red-400">
              {aiErrors[id]}
            </p>
          )}
          {field === "photos" || field === "videos" ? (
            <>
              {mediaErrors[id] && (
                <p className="mb-2 text-xs font-medium text-red-600 dark:text-red-400">{mediaErrors[id]}</p>
              )}
              <ListingMediaEditor
                sections={field}
                slots={mediaPhotoSlots(rowMediaState, listing)}
                altTextBySlot={rowMediaState.altTextBySlot}
                onMovePhoto={(from, to) => updateMedia(listing, (m) => moveMediaPhoto(m, from, to))}
                onRemovePhoto={(slotId) => removePhoto(listing, slotId)}
                onAltTextChange={(slotId, text) => updateMedia(listing, (m) => setMediaAltText(m, slotId, text))}
                onAddPhotos={(files) => addPhotos(listing, files)}
                videos={rowMediaState.videos}
                videoErrors={rowMediaState.videoErrors}
                onSelectVideo={(slot, file) => void selectVideo(listing, slot, file)}
                onMoveVideo={(from, to) => updateMedia(listing, (m) => moveMediaVideo(m, from, to))}
              />
            </>
          ) : showsBlock(listing) ? (
            <VariationRowBlock
              listing={listing}
              field={field}
              form={variationFormFor(listing)}
              status={variationOriginals[id] ? "ready" : inventoryDone.has(id) ? "missing" : "loading"}
              expanded={expandedBlocks[id] ?? false}
              onToggle={() => setExpandedBlocks((prev) => ({ ...prev, [id]: !prev[id] }))}
              onChange={(partial) => editVariations(id, partial)}
              variationProperties={properties ? properties.filter((p) => p.supportsVariations) : null}
              processingProfiles={options.processingProfiles}
              currencyCode={currencyCode}
              showErrors={showVariationErrors}
              photoSlots={variationPhotoSlots(listing)}
              photosLoaded={variationImageOriginals[id] !== undefined}
            />
          ) : (
            <BulkFieldInput
              field={field}
              listing={listing}
              value={valueOf(listing, field)}
              options={options}
              onChange={(value) => setValue(id, field, value)}
            />
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-zinc-50 font-sans dark:bg-black">
      <div className="mx-auto w-full max-w-[96rem] px-4 py-8 sm:px-6">
        {/* ---- top bar ---- */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setNavOpen((open) => !open)}
              aria-expanded={navOpen}
              aria-controls="bulk-field-nav"
              aria-label={navOpen ? "Hide field list" : "Show field list"}
              className="flex h-9 w-9 items-center justify-center rounded-lg text-zinc-600 hover:bg-black/[.04] dark:text-zinc-300 dark:hover:bg-white/[.06]"
            >
              <svg aria-hidden="true" viewBox="0 0 20 20" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.6">
                <rect x="3" y="4" width="14" height="12" rx="2" />
                <path d="M8 4v12" />
              </svg>
            </button>
            <div>
              {shopName && <p className="text-xs font-medium text-zinc-500">{shopName}</p>}
              <h1 className="text-xl font-semibold tracking-tight text-black dark:text-zinc-50">
                {listings == null ? "Loading listings…" : `Editing ${count} listing${count === 1 ? "" : "s"}`}
              </h1>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Link
              href="/listings"
              // Leaving mid-write would abandon listings half-saved, so the way
              // out is closed until the run has finished.
              aria-disabled={saving || undefined}
              tabIndex={saving ? -1 : undefined}
              onClick={(e) => {
                if (saving) e.preventDefault();
              }}
              className={`inline-flex h-9 items-center rounded-full border border-black/[.08] px-4 text-sm font-medium transition-colors dark:border-white/[.145] ${
                saving ? "pointer-events-none opacity-40" : "hover:bg-black/[.04] dark:hover:bg-white/[.06]"
              }`}
            >
              Cancel
            </Link>
            <button
              type="button"
              onClick={() => setScheduling(true)}
              disabled={saving || syncCount === 0}
              className="inline-flex h-9 items-center rounded-full border border-black/[.08] px-4 text-sm font-medium transition-colors hover:bg-black/[.04] disabled:opacity-40 dark:border-white/[.145] dark:hover:bg-white/[.06]"
            >
              Schedule
            </button>
            <button
              type="button"
              onClick={() => void save()}
              disabled={saving || syncCount === 0}
              className="inline-flex h-9 items-center gap-2 rounded-full bg-primary px-4 text-sm font-medium text-white transition-colors hover:bg-primary-dark disabled:opacity-40"
            >
              {saving && (
                <svg aria-hidden="true" viewBox="0 0 16 16" className="h-4 w-4 animate-spin" fill="none">
                  <circle cx="8" cy="8" r="6" stroke="currentColor" strokeOpacity="0.3" strokeWidth="2" />
                  <path d="M14 8a6 6 0 0 0-6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                </svg>
              )}
              {saving ? "Syncing…" : `Sync updates${syncCount > 0 ? ` (${syncCount})` : ""}`}
            </button>
          </div>
        </div>
        <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
          Changes are written to Etsy only when you press Sync updates. Untick a row to leave that listing alone.
        </p>
        {progress && (
          <p role="status" className="mt-2 text-sm font-medium text-zinc-700 dark:text-zinc-200">
            Syncing {progress.done} of {progress.total}…
          </p>
        )}
        {progress && jobStatus && <JobStatus job={jobStatus} className="mt-1" />}

        {scheduling && (
          <ScheduleDialog
            heading="Schedule these edits"
            description={
              <>
                {syncCount} listing{syncCount === 1 ? "" : "s"} will be updated at this time, exactly as Sync updates
                would. Nothing is sent to Etsy until then.
              </>
            }
            submitLabel="Schedule edits"
            onSubmit={scheduleEdits}
            onClose={() => setScheduling(false)}
          />
        )}

        <div className="mt-6 flex flex-col gap-6 lg:flex-row">
          {navOpen && (
            <aside id="bulk-field-nav" className="lg:w-56 lg:shrink-0">
              <BulkSidebar selection={selection} onSelect={setSelection} pendingByField={pendingByField} />
            </aside>
          )}

          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-semibold text-zinc-800 dark:text-zinc-100">{label}</h2>

            {aiField && (
              <AiEditsBar
                fieldLabel={label}
                settings={ai}
                onChange={setAi}
                onOptimize={() => void optimizeTicked()}
                running={aiRunningCount}
                targetedCount={targetedCount}
              />
            )}
            {showApplyControl && (
              <BulkApplyControl
                key={field}
                field={field}
                options={options}
                attributeChoices={attributeChoicesAcross(field, listings ?? [], options)}
                targetedCount={targetedCount}
                currencySymbol={currencySymbol}
                onApply={applyToTicked}
              />
            )}

            <div className="mt-4 flex items-center gap-3">
              <input
                ref={masterRef}
                type="checkbox"
                aria-label="Select all listings"
                checked={allVisibleTargeted}
                disabled={visible.length === 0}
                onChange={(e) =>
                  setTargeted((prev) => ({
                    ...prev,
                    ...Object.fromEntries(visible.map((l) => [l.listingId, e.target.checked])),
                  }))
                }
                className="h-4 w-4 cursor-pointer accent-primary"
              />
              <label className="block flex-1 text-sm">
                <span className="sr-only">Search listings</span>
                <input
                  type="search"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search these listings by title…"
                  className={`${INPUT_CLS} h-10`}
                />
              </label>
            </div>

            <div className="mt-3">
              {listings == null &&
                Array.from({ length: 3 }).map((_, i) => (
                  <div
                    key={i}
                    className="mb-3 h-24 animate-pulse rounded-xl border border-black/10 bg-white dark:border-white/15 dark:bg-zinc-950"
                  />
                ))}

              {listings != null && visible.length === 0 && (
                <p className="rounded-xl border border-black/10 bg-white px-4 py-10 text-center text-sm text-zinc-500 dark:border-white/15 dark:bg-zinc-950">
                  {count === 0 ? "No listings selected. Pick some on the listings page first." : "No listings match that search."}
                </p>
              )}

              <VirtualListingRows
                items={visible}
                getKey={(l) => l.listingId}
                estimate={ROW_ESTIMATE[field] ?? 150}
                renderRow={renderRow}
              />
            </div>
          </div>
        </div>
      </div>
      {unsavedDialog}
    </div>
  );
}

const AI_CONCURRENCY = 3;

/** Rough row heights per field, for the virtual list's rows it hasn't measured yet. */
const ROW_ESTIMATE: Partial<Record<BulkFieldKey, number>> = {
  description: 220,
  photos: 420,
  videos: 260,
  personalization: 320,
  variations: 230,
};

function symbolFor(currencyCode: string): string {
  try {
    return (
      new Intl.NumberFormat("en-US", { style: "currency", currency: currencyCode, currencyDisplay: "narrowSymbol" })
        .formatToParts(0)
        .find((p) => p.type === "currency")?.value ?? currencyCode
    );
  } catch {
    return currencyCode;
  }
}

/**
 * Turn one edited field into its patch entry, or null when the typed value
 * isn't usable yet (an empty number box, an unpicked dropdown) — an
 * in-progress value is simply not part of the save.
 */
function patchEntry(field: BulkFieldKey, value: FieldValue): BulkListingPatch | null {
  const asId = (): number | null => {
    const id = Number.parseInt(String(value), 10);
    return Number.isInteger(id) && id > 0 ? id : null;
  };
  switch (field) {
    case "title":
      return typeof value === "string" && value.trim() ? { title: value.trim() } : null;
    case "description":
      return typeof value === "string" ? { description: value } : null;
    case "tags":
      return Array.isArray(value) && value.length > 0 ? { tags: value as string[] } : null;
    case "materials":
      return Array.isArray(value) && value.length > 0 ? { materials: value as string[] } : null;
    case "about": {
      const about = value as AboutValue;
      return about.whoMade && about.whenMade
        ? { whoMade: about.whoMade, whenMade: about.whenMade, isSupply: about.isSupply }
        : null;
    }
    case "productionPartners": {
      const ids = (Array.isArray(value) ? (value as string[]) : [])
        .map((id) => Number.parseInt(id, 10))
        .filter((id) => Number.isInteger(id) && id > 0);
      return { productionPartnerIds: ids };
    }
    case "personalization":
      return Array.isArray(value)
        ? { personalization: value as PersonalizationQuestionInput[] }
        : null;
    case "taxonomyId": {
      const id = asId();
      return id == null ? null : { taxonomyId: id };
    }
    case "shopSectionId": {
      const id = asId();
      return id == null ? null : { shopSectionId: id };
    }
    case "shippingProfileId": {
      const id = asId();
      return id == null ? null : { shippingProfileId: id };
    }
    case "returnPolicyId": {
      const id = asId();
      return id == null ? null : { returnPolicyId: id };
    }
    case "readinessStateId": {
      const id = asId();
      return id == null ? null : { readinessStateId: id };
    }
    case "price": {
      const price = Number.parseFloat(String(value));
      return Number.isFinite(price) && price > 0 ? { price } : null;
    }
    case "quantity": {
      const quantity = Number.parseInt(String(value), 10);
      return Number.isInteger(quantity) && quantity >= 0 ? { quantity } : null;
    }
    case "sku":
      return typeof value === "string" ? { sku: value } : null;
    case "itemWeight": {
      const weight = value as WeightValue;
      const parsed = Number.parseFloat(weight.weight);
      return Number.isFinite(parsed) && parsed > 0 && weight.unit
        ? { itemWeight: parsed, itemWeightUnit: weight.unit as BulkListingPatch["itemWeightUnit"] }
        : null;
    }
    case "itemSize": {
      const size = value as SizeValue;
      if (!size.unit) return null;
      const patch: BulkListingPatch = {
        itemDimensionsUnit: size.unit as BulkListingPatch["itemDimensionsUnit"],
      };
      const dimensions = [
        ["length", "itemLength"],
        ["width", "itemWidth"],
        ["height", "itemHeight"],
      ] as const;
      let any = false;
      for (const [from, to] of dimensions) {
        const parsed = Number.parseFloat(size[from]);
        if (Number.isFinite(parsed) && parsed > 0) {
          Object.assign(patch, { [to]: parsed });
          any = true;
        }
      }
      return any ? patch : null;
    }
    default:
      return null;
  }
}

/**
 * Fold Etsy's own account of the listing back into the row. This runs after
 * {@link applySaved} and wins over it: what the screen shows for these fields
 * is then what Etsy answered with, not what the patch asked for. A field the
 * response left out isn't touched.
 */
export function applyConfirmed(
  listing: BulkListingDetail,
  confirmed: ConfirmedListingFields,
): BulkListingDetail {
  const next = { ...listing };
  for (const [key, value] of Object.entries(confirmed) as [keyof ConfirmedListingFields, unknown][]) {
    if (value === undefined) continue;
    (next as Record<string, unknown>)[key] = value;
  }
  return next;
}

/** Fold a saved patch back into the row, so it stops reading as pending. */
function applySaved(listing: BulkListingDetail, patch: BulkListingPatch): BulkListingDetail {
  return {
    ...listing,
    ...(patch.title !== undefined ? { title: patch.title } : {}),
    ...(patch.description !== undefined ? { description: patch.description } : {}),
    ...(patch.tags !== undefined ? { tags: patch.tags } : {}),
    ...(patch.materials !== undefined ? { materials: patch.materials } : {}),
    ...(patch.whoMade !== undefined ? { whoMade: patch.whoMade } : {}),
    ...(patch.whenMade !== undefined ? { whenMade: patch.whenMade } : {}),
    ...(patch.isSupply !== undefined ? { isSupply: patch.isSupply } : {}),
    ...(patch.productionPartnerIds !== undefined
      ? { productionPartnerIds: patch.productionPartnerIds }
      : {}),
    ...(patch.taxonomyId !== undefined ? { taxonomyId: patch.taxonomyId } : {}),
    ...(patch.shopSectionId !== undefined ? { shopSectionId: patch.shopSectionId } : {}),
    ...(patch.personalization !== undefined
      ? { personalizationQuestions: patch.personalization }
      : {}),
    ...(patch.shippingProfileId !== undefined ? { shippingProfileId: patch.shippingProfileId } : {}),
    ...(patch.returnPolicyId !== undefined ? { returnPolicyId: patch.returnPolicyId } : {}),
    ...(patch.readinessStateId !== undefined ? { readinessStateId: patch.readinessStateId } : {}),
    ...(patch.itemWeight !== undefined ? { itemWeight: patch.itemWeight } : {}),
    ...(patch.itemWeightUnit !== undefined ? { itemWeightUnit: patch.itemWeightUnit } : {}),
    ...(patch.itemLength !== undefined ? { itemLength: patch.itemLength } : {}),
    ...(patch.itemWidth !== undefined ? { itemWidth: patch.itemWidth } : {}),
    ...(patch.itemHeight !== undefined ? { itemHeight: patch.itemHeight } : {}),
    ...(patch.itemDimensionsUnit !== undefined
      ? { itemDimensionsUnit: patch.itemDimensionsUnit }
      : {}),
    ...(patch.price !== undefined ? { price: patch.price } : {}),
    ...(patch.quantity !== undefined ? { quantity: patch.quantity } : {}),
    ...(patch.sku !== undefined ? { sku: patch.sku } : {}),
  };
}

function SaveResultsMessage({ results, listings }: { results: SaveResult[]; listings: BulkListingDetail[] }) {
  const failed = results.filter((r) => !r.ok);
  const partial = results.filter((r) => r.partial);
  return (
    <>
      Updated {results.length - failed.length} of {results.length} listings.
      {failed.length > 0 && ` ${failed.length} failed.`}
      {partial.length > 0 && ` ${partial.length} partly saved — everything but their variation photos.`}
      {failed.length > 0 && " Rows that failed keep their changes below and stay selected."}
      {failed.length > 0 && (
        <ul className="mt-1 list-disc pl-5 text-xs text-red-600 dark:text-red-400">
          {failed.map((r) => (
            <li key={r.listingId}>
              {listings.find((l) => l.listingId === r.listingId)?.title ?? `Listing #${r.listingId}`}:{" "}
              {r.partial && "Partly saved. "}
              {r.error}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
