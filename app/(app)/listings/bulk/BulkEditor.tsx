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
import { toVariationPatch, type VariationGrid } from "@/lib/etsy/variation-grid";
import type { PersonalizationQuestionInput } from "@/lib/etsy/listing-personalization";
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
import VariationsCard from "./VariationsCard";
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

/** Deep enough for the shapes a field value can take. */
function sameValue(a: FieldValue, b: FieldValue): boolean {
  if (typeof a !== "object" && typeof b !== "object") return a === b;
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Which parts of a row's media grid differ from the listing as Etsy has it. */
function mediaChanges(listing: BulkListingDetail, state: ExistingMediaState | undefined) {
  if (!state) return { photos: false, videos: false };
  const now = mediaSavePayload(state).payload;
  const was = mediaSavePayload(initialExistingMedia(listing)).payload;
  return {
    photos: JSON.stringify(now.images) !== JSON.stringify(was.images),
    videos: JSON.stringify(now.videos) !== JSON.stringify(was.videos),
  };
}

const newPhotoId = () => Math.random().toString(36).slice(2, 10);

const numberOr = (value: number | null, digits = 2): string =>
  value == null ? "" : digits > 0 ? value.toFixed(digits) : String(value);

/**
 * The bulk editor: every selected listing on its own row, each edited
 * individually, with an explicit per-field control for writing one value
 * across the ticked rows. Nothing reaches Etsy until Sync updates is pressed.
 */
export default function BulkEditor({ listingIds }: { listingIds: number[] }) {
  const [listings, setListings] = useState<BulkListingDetail[] | null>(null);
  const [missing, setMissing] = useState<number[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [options, setOptions] = useState<BulkOptions>(EMPTY_OPTIONS);
  const [attributes, setAttributes] = useState<Record<number, ListingAttribute[]>>({});
  const [grids, setGrids] = useState<Record<number, VariationGrid>>({});
  const [gridsLoaded, setGridsLoaded] = useState(false);
  /**
   * What has already been asked for. A ref rather than state: it only guards
   * a fetch from being repeated, and nothing rendered reads it.
   */
  const requested = useRef({ attributes: false, grids: false, taxonomies: new Set<number>() });

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
  const [results, setResults] = useState<SaveResult[] | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [scheduleNote, setScheduleNote] = useState(false);
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
      // eslint-disable-next-line react-hooks/set-state-in-effect
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
        setMissing(body.missing ?? []);
        setTargeted(Object.fromEntries(body.listings.map((l) => [l.listingId, true])));
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setListings([]);
        setLoadError(err instanceof Error ? err.message : "Failed to load the selected listings.");
      });
    return () => controller.abort();
  }, [idsKey, listingIds.length]);

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
  useEffect(() => {
    if (!attributeFieldSelected || !taxonomyIdsKey) return;
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
  }, [attributeFieldSelected, taxonomyIdsKey]);

  // Same for the variation grids.
  useEffect(() => {
    if (field !== "variations" || requested.current.grids) return;
    if (listings == null || listings.length === 0) return;
    requested.current.grids = true;
    fetch(`/api/etsy/listings/bulk/inventory?ids=${idsKey}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((body: { inventories?: Record<string, VariationGrid> } | null) => {
        const raw = body?.inventories ?? {};
        setGrids(Object.fromEntries(Object.entries(raw).map(([id, grid]) => [Number(id), grid])));
      })
      .catch(() => {})
      // Only once the read has actually come back does a card stop saying
      // "Loading…" — otherwise an empty map reads as "no inventory record".
      .finally(() => setGridsLoaded(true));
  }, [field, listings, idsKey]);

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
      if (INVENTORY_LOCKED.has(key) && listing.hasVariations) return false;
      return true;
    },
    [],
  );

  /** Write one instruction into every ticked listing — the explicit apply-to-all. */
  function applyToTicked(instruction: ApplyInstruction) {
    setEdited((prev) => {
      const next = { ...prev };
      for (const listing of listings ?? []) {
        if (!targeted[listing.listingId] || !editable(listing, field)) continue;
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
      case "attribute": {
        // Matched by name: the same value has a different id on each category.
        const property = propertyForListing(field, listing, options);
        if (!property) return null;
        const picked = property.possibleValues.find(
          (v) => v.valueId != null && v.name === instruction.valueName,
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

  const updates = useMemo(() => {
    return (listings ?? [])
      .filter((l) => targeted[l.listingId])
      .map((l) => ({ listingId: l.listingId, patch: patchFor(l) }))
      .filter((u) => Object.keys(u.patch).length > 0);
  }, [listings, targeted, patchFor]);

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

  const mediaFor = (listing: BulkListingDetail) => media[listing.listingId] ?? initialExistingMedia(listing);

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
    }
    return counts;
  }, [listings, edited, targeted, editable, originalValue, media]);

  const visible = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const all = listings ?? [];
    return needle ? all.filter((l) => l.title.toLowerCase().includes(needle)) : all;
  }, [listings, search]);

  const targetedCount = (listings ?? []).filter((l) => targeted[l.listingId]).length;

  async function save() {
    setSaving(true);
    setSaveError(null);
    setResults(null);
    try {
      let fieldResults: SaveResult[] = [];
      if (updates.length > 0) {
        const res = await fetch("/api/etsy/listings/bulk/save", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ updates }),
        });
        if (!res.ok) throw new Error(await errorFrom(res));
        fieldResults = ((await res.json()) as { results: SaveResult[] }).results;
        // Saved values are now the listings' own values — clear the edits that
        // landed so the rows stop showing them as pending.
        const savedIds = new Set(fieldResults.filter((r) => r.ok).map((r) => r.listingId));
        setListings((prev) => (prev ?? []).map((l) => (savedIds.has(l.listingId) ? applySaved(l, patchFor(l)) : l)));
        setEdited((prev) => {
          const next = { ...prev };
          for (const id of savedIds) delete next[id];
          return next;
        });
      }

      // Media goes one listing at a time: each carries its own files.
      const mediaResults: SaveResult[] = [];
      for (const listing of mediaUpdates) {
        const id = listing.listingId;
        try {
          const res = await fetch(`/api/etsy/listings/${id}/media`, {
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
          mediaResults.push(
            body.ok
              ? { listingId: id, ok: true }
              : { listingId: id, ok: false, error: body.failed.map((f) => `${f.name}: ${f.error}`).join("; ") },
          );
        } catch (err) {
          mediaResults.push({ listingId: id, ok: false, error: err instanceof Error ? err.message : "Save failed." });
        }
      }

      const byId = new Map<number, SaveResult>();
      for (const result of [...fieldResults, ...mediaResults]) {
        const earlier = byId.get(result.listingId);
        byId.set(
          result.listingId,
          !earlier
            ? result
            : {
                listingId: result.listingId,
                ok: earlier.ok && result.ok,
                ...(earlier.ok && result.ok
                  ? {}
                  : { error: [earlier.error, result.error].filter(Boolean).join("; ") }),
              },
        );
      }
      setResults([...byId.values()]);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Save failed.");
    } finally {
      setSaving(false);
    }
  }

  const resultFor = (listingId: number) => results?.find((r) => r.listingId === listingId);
  const count = (listings ?? []).length;
  const label = labelFor(field);
  const showApplyControl = applyKindFor(field) !== "none" && !isReadOnlyField(field);

  return (
    <div className="min-h-screen bg-zinc-50 font-sans dark:bg-black">
      <div className="mx-auto w-full max-w-[96rem] px-4 py-8 sm:px-6">
        {/* ---- top bar ---- */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight text-black dark:text-zinc-50">
            {listings == null ? "Loading listings…" : `Editing ${count} listing${count === 1 ? "" : "s"}`}
          </h1>
          <div className="flex items-center gap-2">
            <Link
              href="/listings"
              className="inline-flex h-9 items-center rounded-full border border-black/[.08] px-4 text-sm font-medium transition-colors hover:bg-black/[.04] dark:border-white/[.145] dark:hover:bg-white/[.06]"
            >
              Cancel
            </Link>
            <button
              type="button"
              onClick={() => setScheduleNote((open) => !open)}
              aria-expanded={scheduleNote}
              className="inline-flex h-9 items-center rounded-full border border-black/[.08] px-4 text-sm font-medium transition-colors hover:bg-black/[.04] dark:border-white/[.145] dark:hover:bg-white/[.06]"
            >
              Schedule
            </button>
            <button
              type="button"
              onClick={save}
              disabled={saving || syncCount === 0}
              className="inline-flex h-9 items-center rounded-full bg-primary px-4 text-sm font-medium text-white transition-colors hover:bg-primary-dark disabled:opacity-40"
            >
              {saving ? "Syncing…" : `Sync updates${syncCount > 0 ? ` (${syncCount})` : ""}`}
            </button>
          </div>
        </div>
        <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
          Changes are written to Etsy only when you press Sync updates. Untick a row to leave that
          listing alone.
        </p>

        {scheduleNote && (
          <div className="mt-4 rounded-xl border border-black/10 bg-white px-4 py-3 text-sm dark:border-white/15 dark:bg-zinc-950">
            Scheduling covers publishing a <em>new</em> listing from a draft — a scheduled job holds
            the images it will upload. An edit to listings that are already live has nothing to
            render ahead of time, so it isn&apos;t schedulable yet.{" "}
            <Link href="/schedule" className="font-medium text-primary underline underline-offset-2">
              See scheduled listings
            </Link>
          </div>
        )}

        {loadError && (
          <div className="mt-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/50 dark:text-red-300">
            {loadError}
          </div>
        )}
        {saveError && (
          <div className="mt-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/50 dark:text-red-300">
            {saveError}
          </div>
        )}
        {missing.length > 0 && (
          <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950/50 dark:text-amber-300">
            {missing.length} selected listing{missing.length === 1 ? "" : "s"} could not be loaded
            and {missing.length === 1 ? "is" : "are"} not shown. Refresh the shop and try again.
          </div>
        )}
        {results && (
          <div
            role="status"
            className="mt-4 rounded-xl border border-black/10 bg-white px-4 py-3 text-sm dark:border-white/15 dark:bg-zinc-950"
          >
            Saved {results.filter((r) => r.ok).length} of {results.length} listings.
            {results.some((r) => !r.ok) && " Rows that failed keep their changes below."}
          </div>
        )}

        <div className="mt-6 flex flex-col gap-6 lg:flex-row">
          <aside className="lg:w-56 lg:shrink-0">
            <BulkSidebar selection={selection} onSelect={setSelection} pendingByField={pendingByField} />
          </aside>

          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-semibold text-zinc-800 dark:text-zinc-100">{label}</h2>

            <label className="mt-2 block text-sm">
              <span className="sr-only">Search listings</span>
              <input
                type="search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search these listings by title…"
                className={`${INPUT_CLS} h-10`}
              />
            </label>

            {showApplyControl && (
              <BulkApplyControl
                field={field}
                options={options}
                attributeChoices={attributeChoicesAcross(field, listings ?? [], options)}
                targetedCount={targetedCount}
                onApply={applyToTicked}
              />
            )}

            <div className="mt-4 space-y-3">
              {listings == null &&
                Array.from({ length: 3 }).map((_, i) => (
                  <div
                    key={i}
                    className="h-24 animate-pulse rounded-xl border border-black/10 bg-white dark:border-white/15 dark:bg-zinc-950"
                  />
                ))}

              {listings != null && visible.length === 0 && (
                <p className="rounded-xl border border-black/10 bg-white px-4 py-10 text-center text-sm text-zinc-500 dark:border-white/15 dark:bg-zinc-950">
                  {count === 0
                    ? "No listings selected. Pick some on the listings page first."
                    : "No listings match that search."}
                </p>
              )}

              {visible.map((listing) => {
                const result = resultFor(listing.listingId);
                const rowPatch = patchFor(listing);
                const rowMedia = mediaChanges(listing, media[listing.listingId]);
                const changed =
                  Object.keys(rowPatch).length + (rowMedia.photos ? 1 : 0) + (rowMedia.videos ? 1 : 0);
                const rowMediaState = mediaFor(listing);
                return (
                  <div
                    key={listing.listingId}
                    role="group"
                    aria-label={listing.title}
                    className="rounded-xl border border-black/10 bg-white p-4 dark:border-white/15 dark:bg-zinc-950"
                  >
                    <div className="flex items-start gap-3">
                      <input
                        type="checkbox"
                        aria-label={`Include ${listing.title} in the save`}
                        checked={targeted[listing.listingId] ?? false}
                        onChange={(e) =>
                          setTargeted((p) => ({ ...p, [listing.listingId]: e.target.checked }))
                        }
                        className="mt-1 h-4 w-4 cursor-pointer accent-primary"
                      />
                      <span className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded bg-zinc-100 dark:bg-zinc-800">
                        {listing.thumbnailUrl ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={listing.thumbnailUrl} alt="" className="h-full w-full object-cover" />
                        ) : (
                          <span className="text-[10px] text-zinc-400">—</span>
                        )}
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="line-clamp-1 text-sm font-medium text-zinc-800 dark:text-zinc-100">
                          {listing.title}
                        </p>
                        <p className="text-xs text-zinc-500">
                          {listing.state}
                          {changed > 0 && ` · ${changed} change${changed === 1 ? "" : "s"} pending`}
                          {result && !result.ok && (
                            <span className="text-red-600 dark:text-red-400"> · {result.error}</span>
                          )}
                          {result?.ok && <span className="text-green-700 dark:text-green-400"> · saved</span>}
                        </p>
                      </div>
                    </div>

                    <div className="mt-3 pl-7">
                      {field === "photos" || field === "videos" ? (
                        <>
                          {mediaErrors[listing.listingId] && (
                            <p className="mb-2 text-xs font-medium text-red-600 dark:text-red-400">
                              {mediaErrors[listing.listingId]}
                            </p>
                          )}
                          <ListingMediaEditor
                            sections={field}
                            slots={mediaPhotoSlots(rowMediaState, listing)}
                            altTextBySlot={rowMediaState.altTextBySlot}
                            onMovePhoto={(from, to) => updateMedia(listing, (m) => moveMediaPhoto(m, from, to))}
                            onRemovePhoto={(slotId) => removePhoto(listing, slotId)}
                            onAltTextChange={(slotId, text) =>
                              updateMedia(listing, (m) => setMediaAltText(m, slotId, text))
                            }
                            onAddPhotos={(files) => addPhotos(listing, files)}
                            videos={rowMediaState.videos}
                            videoErrors={rowMediaState.videoErrors}
                            onSelectVideo={(slot, file) => void selectVideo(listing, slot, file)}
                            onMoveVideo={(from, to) => updateMedia(listing, (m) => moveMediaVideo(m, from, to))}
                          />
                        </>
                      ) : field === "variations" ? (
                        <VariationsCard
                          listing={listing}
                          grid={
                            (edited[listing.listingId]?.variations as VariationGrid | undefined) ??
                            grids[listing.listingId] ??
                            null
                          }
                          loading={!gridsLoaded}
                          processingProfiles={options.processingProfiles}
                          onChange={(grid) => setValue(listing.listingId, "variations", grid as FieldValue)}
                        />
                      ) : (
                        <BulkFieldInput
                          field={field}
                          listing={listing}
                          value={valueOf(listing, field)}
                          options={options}
                          onChange={(value) => setValue(listing.listingId, field, value)}
                        />
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
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
    case "variations": {
      const grid = value as unknown as VariationGrid;
      return grid && Array.isArray(grid.combinations) && grid.combinations.length > 0
        ? { variations: toVariationPatch(grid) }
        : null;
    }
    default:
      return null;
  }
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
