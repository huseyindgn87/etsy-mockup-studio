"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { EditorSectionCard } from "./editor-sections";
import VariationsSection, { type VariationPhotoOption } from "./VariationsSection";
import {
  WHEN_MADE_VALUES,
  WHO_MADE_OPTIONS,
  formatWhenMade,
  howItsMadeError,
  type WhenMade,
  type WhoMade,
} from "@/lib/etsy/listing-classification";
import {
  EMPTY_PERSONALIZATION_QUESTION,
  PERSONALIZATION_CHAR_COUNT_MAX,
  PERSONALIZATION_CHAR_COUNT_MIN,
  PERSONALIZATION_FIELD_TYPES,
  PERSONALIZATION_INSTRUCTIONS_MAX,
  PERSONALIZATION_MAX_FILES_MAX,
  PERSONALIZATION_MAX_FILES_MIN,
  PERSONALIZATION_MAX_OPTIONS,
  PERSONALIZATION_MAX_QUESTIONS,
  PERSONALIZATION_OPTION_LABEL_MAX,
  PERSONALIZATION_QUESTION_TEXT_MAX,
  personalizationQuestionError,
  type PersonalizationFieldType,
  type PersonalizationQuestionInput,
} from "@/lib/etsy/listing-personalization";
import { addCommaSeparated } from "@/lib/etsy/form-list";

/** The shape this form edits — read by the page when publishing `mode: "new"`. */
export interface ListingFormProperty {
  name: string;
  valueIds: number[];
  values: string[];
  scaleId?: number | null;
}

/** One variation dimension (colour, size, or a user-typed custom one). */
export interface ListingFormVariation {
  /** A real taxonomy property id, or 513/514 for a custom ("Custom") variation. */
  propertyId: number;
  name: string;
  isCustom: boolean;
  /**
   * A stable id per option, assigned once when the option is added and never
   * recomputed from its position — combination rows (variationRows /
   * variationRowEnabled) are keyed by these, so renaming or reordering an
   * option never scrambles or drops its already-entered values. Only
   * deleting an option (removing its id from this array) does.
   */
  valueIds: number[];
  values: string[];
  linksPhotos: boolean;
  /** The chosen unit system when the property has several (e.g. US/UK/EU sizing). */
  scaleId?: number | null;
}

export type VariationToggleKey = "price" | "readiness" | "quantity" | "sku";

/** One section of the listing editor's scrolling form that this form's fields live in. */
export type ListingFormTab =
  | "title"
  | "description"
  | "tags"
  | "details"
  | "howMade"
  | "personalization"
  | "price"
  | "inventory"
  | "variations"
  | "shipping"
  | "settings";

export interface VariationToggleState {
  enabled: boolean;
  /** Indices into `variations` this field varies by (0, 1, or both). */
  appliesTo: number[];
}

const EMPTY_VARIATION_TOGGLES: Record<VariationToggleKey, VariationToggleState> = {
  price: { enabled: false, appliesTo: [] },
  readiness: { enabled: false, appliesTo: [] },
  quantity: { enabled: false, appliesTo: [] },
  sku: { enabled: false, appliesTo: [] },
};
const EMPTY_VARIATION_ROWS: Record<VariationToggleKey, Record<string, string>> = {
  price: {},
  readiness: {},
  quantity: {},
  sku: {},
};

export interface ListingFormValue {
  title: string;
  description: string;
  tags: string[];
  materials: string[];
  taxonomyId: number | null;
  taxonomyPath: string;
  shopSectionId: number | null;
  shopSectionTitle: string;
  /** Keyed by property id. */
  properties: Record<number, ListingFormProperty>;
  price: string;
  quantity: string;
  sku: string;
  /** Etsy's processing-profile id — required on every physical listing. */
  readinessStateId: number | null;
  /** No field shows it: copied from the source listing and stored with the draft. */
  shippingProfileId: number | null;
  /** No field shows it: copied from the source listing and stored with the draft. */
  returnPolicyId: number | null;
  /**
   * Etsy's "How it's made" classification — `who_made`/`is_supply`/`when_made`
   * plus production partners (required when `whoMade` is "someone_else").
   * Always the user's own choice here; never borrowed from another listing.
   */
  whoMade: WhoMade;
  isSupply: boolean;
  whenMade: WhenMade;
  productionPartnerIds: number[];
  /**
   * Up to {@link PERSONALIZATION_MAX_QUESTIONS} personalization questions
   * (this tab exposes 2, matching Vela's layout). Empty -> the listing isn't
   * personalizable.
   */
  personalizationQuestions: PersonalizationQuestionInput[];
  /** Up to 3, in display order. */
  variations: ListingFormVariation[];
  variationToggles: Record<VariationToggleKey, VariationToggleState>;
  /**
   * Per field, keyed by the joined `valueIds` of that field's `appliesTo`-scoped
   * subset of a combination — e.g. if price only varies by the first variation,
   * every row sharing that value reads/writes the same key, which is what
   * collapses the "price" column to one cell per value instead of one per row.
   */
  variationRows: Record<VariationToggleKey, Record<string, string>>;
  /**
   * Per full combination (all variation value ids joined) — `false` marks
   * that offering "not currently made". Absent (or `true`) means enabled.
   * Disabled combinations are never dropped: Etsy requires every property-
   * value combination to be supplied, so they're sent with is_enabled:false.
   */
  variationRowEnabled: Record<string, boolean>;
  /**
   * The photo grid slot id (see `slotIdFor`) shown for each value of the one
   * variation with `linksPhotos`, keyed by that value's id.
   */
  variationPhotos: Record<string, string>;
  /** Shows the listing at the top of the shop's home page. Sent as `featured_rank` on an existing listing (not settable at draft creation). */
  featureListing: boolean;
  /**
   * Etsy Ads participation. Etsy's Open API has no endpoint for Ads
   * campaigns, so this is never sent anywhere — kept only so the Settings
   * tab can mirror Etsy's own listing editor and say so explicitly.
   */
  promoteWithAds: boolean;
  /** Automatic (true, Etsy's own default) or Manual renewal. Sent as `should_auto_renew`. */
  autoRenew: boolean;
}

export const EMPTY_LISTING_FORM: ListingFormValue = {
  title: "",
  description: "",
  tags: [],
  materials: [],
  taxonomyId: null,
  taxonomyPath: "",
  shopSectionId: null,
  shopSectionTitle: "",
  properties: {},
  price: "",
  quantity: "1",
  sku: "",
  readinessStateId: null,
  shippingProfileId: null,
  returnPolicyId: null,
  whoMade: "i_did",
  isSupply: false,
  whenMade: "made_to_order",
  productionPartnerIds: [],
  personalizationQuestions: [],
  variations: [],
  variationToggles: EMPTY_VARIATION_TOGGLES,
  variationRows: EMPTY_VARIATION_ROWS,
  variationRowEnabled: {},
  variationPhotos: {},
  featureListing: false,
  promoteWithAds: false,
  autoRenew: true,
};

const MAX_TAGS = 13;
const MAX_TAG_LENGTH = 20;
const MAX_TITLE_LENGTH = 140;

interface TaxonomyNode {
  id: number;
  level: number;
  name: string;
  parentId: number | null;
  children: TaxonomyNode[];
}
interface FlatTaxonomyNode {
  id: number;
  path: string;
}
interface TaxonomyPropertyScale {
  scaleId: number;
  displayName: string;
}
interface TaxonomyProperty {
  propertyId: number;
  name: string;
  displayName: string;
  isRequired: boolean;
  isMultivalued: boolean;
  maxValuesAllowed: number | null;
  /** Settable as a plain listing attribute (the Details section). */
  supportsAttributes: boolean;
  /** Usable as an inventory variation (the Variations section). */
  supportsVariations: boolean;
  /** Alternate unit systems for this property's values (e.g. US/UK/EU sizing) — empty when it has none. */
  scales: TaxonomyPropertyScale[];
  possibleValues: { valueId: number | null; name: string; scaleId: number | null }[];
}
interface ShopSectionOption {
  shopSectionId: number;
  title: string;
}
interface ProcessingProfileOption {
  readinessStateId: number;
  readinessState: "ready_to_ship" | "made_to_order";
  minProcessingDays: number;
  maxProcessingDays: number;
  displayLabel: string;
}
interface ProductionPartnerOption {
  productionPartnerId: number;
  partnerName: string;
  location: string;
}

/** Shown for both pickers below instead of Etsy's raw 429 body, which isn't user-facing text. */
const RATE_LIMIT_MESSAGE = "Etsy rate limit reached, try again shortly.";

/** Etsy's shop-section titles come back HTML-escaped (e.g. "&gt;&gt;HALLOWEEN&lt;&lt;"). */
function decodeHtmlEntities(s: string): string {
  if (typeof document === "undefined") return s;
  const el = document.createElement("textarea");
  el.innerHTML = s;
  return el.value;
}

function flattenTaxonomy(nodes: TaxonomyNode[], prefix = ""): FlatTaxonomyNode[] {
  const out: FlatTaxonomyNode[] = [];
  for (const n of nodes) {
    const path = prefix ? `${prefix} > ${n.name}` : n.name;
    out.push({ id: n.id, path });
    out.push(...flattenTaxonomy(n.children, path));
  }
  return out;
}

/**
 * Listing-editing form fields: title, description, tags, category + category
 * properties + section, price, quantity/SKU, and variations — every section
 * rendered at once, stacked in the editor sidebar's order, each with its own
 * anchor (see `editor-sections.tsx`). Values feed a draft listing on publish;
 * nothing here is sent to Etsy until then.
 */
export default function ListingForm({
  value,
  onChange,
  onGoToSection,
  photoSlots = [],
  currencyCode = null,
  showVariationErrors = false,
  variationErrorJump = 0,
}: {
  value: ListingFormValue;
  onChange: (next: ListingFormValue) => void;
  /** Lets a sub-panel (e.g. the Variations modal) send the user to another section, such as Details to pick a category. */
  onGoToSection?: (section: ListingFormTab) => void;
  /** The photo grid, in upload order — what the Variations Photos tab picks from. */
  photoSlots?: VariationPhotoOption[];
  /** The shop's currency, for the Variations Price tab. */
  currencyCode?: string | null;
  /** Mark per-combination errors (after a refused Publish). */
  showVariationErrors?: boolean;
  /** Changes when a refused Publish should open the first per-combination error. */
  variationErrorJump?: number;
}) {
  const patch = (partial: Partial<ListingFormValue>) => onChange({ ...value, ...partial });

  // ---- tags ----
  const [tagDraft, setTagDraft] = useState("");
  function addTag() {
    const t = tagDraft.trim().slice(0, MAX_TAG_LENGTH);
    if (!t || value.tags.length >= MAX_TAGS) return;
    if (value.tags.some((existing) => existing.toLowerCase() === t.toLowerCase())) {
      setTagDraft("");
      return;
    }
    patch({ tags: [...value.tags, t] });
    setTagDraft("");
  }
  function removeTag(t: string) {
    patch({ tags: value.tags.filter((x) => x !== t) });
  }

  // ---- materials ----
  const [materialDraft, setMaterialDraft] = useState("");
  function addMaterial() {
    const m = materialDraft.trim();
    setMaterialDraft("");
    if (!m || value.materials.some((existing) => existing.toLowerCase() === m.toLowerCase())) return;
    patch({ materials: [...value.materials, m] });
  }
  function removeMaterial(m: string) {
    patch({ materials: value.materials.filter((x) => x !== m) });
  }

  // ---- category picker ----
  const [categoryOpen, setCategoryOpen] = useState(false);
  const [categoryQuery, setCategoryQuery] = useState("");
  const [taxonomyTree, setTaxonomyTree] = useState<TaxonomyNode[] | null>(null);
  const [taxonomyError, setTaxonomyError] = useState<string | null>(null);
  const taxonomy = useMemo(() => (taxonomyTree ? flattenTaxonomy(taxonomyTree) : null), [taxonomyTree]);
  const taxonomyLoading = taxonomyTree == null && taxonomyError == null;
  const categoryRootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetch("/api/etsy/taxonomy")
      .then(async (res) => {
        const body = (await res.json().catch(() => null)) as { tree?: TaxonomyNode[]; error?: string } | null;
        if (!res.ok) {
          throw new Error(res.status === 429 ? RATE_LIMIT_MESSAGE : body?.error || `Request failed (${res.status})`);
        }
        setTaxonomyTree(body?.tree ?? []);
      })
      .catch((err) => {
        setTaxonomyTree([]);
        setTaxonomyError(err instanceof Error ? err.message : "Could not load categories.");
      });
  }, []);

  useEffect(() => {
    if (!categoryOpen) return;
    function onOutside(e: PointerEvent) {
      if (categoryRootRef.current && !categoryRootRef.current.contains(e.target as Node)) {
        setCategoryOpen(false);
      }
    }
    document.addEventListener("pointerdown", onOutside);
    return () => document.removeEventListener("pointerdown", onOutside);
  }, [categoryOpen]);

  const categoryRows = useMemo(() => {
    const q = categoryQuery.trim().toLowerCase();
    const list = taxonomy ?? [];
    if (!q) return list.slice(0, 50);
    return list.filter((n) => n.path.toLowerCase().includes(q)).slice(0, 50);
  }, [taxonomy, categoryQuery]);

  // ---- category properties (depend on the chosen category) ----
  const [properties, setProperties] = useState<TaxonomyProperty[]>([]);
  const [propertiesLoading, setPropertiesLoading] = useState(false);
  const [propertiesError, setPropertiesError] = useState<string | null>(null);

  useEffect(() => {
    if (!value.taxonomyId) {
      // Category cleared — reset synchronously, matching the empty-query
      // reset elsewhere in this app's pickers.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setProperties([]);
      setPropertiesError(null);
      return;
    }
    const controller = new AbortController();
    setPropertiesLoading(true);
    setPropertiesError(null);
    fetch(`/api/etsy/taxonomy/${value.taxonomyId}/properties`, { signal: controller.signal })
      .then(async (res) => {
        const body = (await res.json().catch(() => null)) as
          | { properties?: TaxonomyProperty[]; error?: string }
          | null;
        // Left in deliberately — check the browser console to confirm
        // taxonomy_id is set and see what getPropertiesByTaxonomyId returned.
        console.log(`[ListingForm] GET taxonomy/${value.taxonomyId}/properties ->`, res.status, body);
        if (!res.ok) {
          throw new Error(res.status === 429 ? RATE_LIMIT_MESSAGE : body?.error || `Request failed (${res.status})`);
        }
        setProperties(body?.properties ?? []);
      })
      .catch((err) => {
        if (controller.signal.aborted) return;
        setProperties([]);
        setPropertiesError(err instanceof Error ? err.message : "Could not load category properties.");
      })
      .finally(() => setPropertiesLoading(false));
    return () => controller.abort();
  }, [value.taxonomyId]);

  // A property can support attributes, variations, or both — split once so
  // Details and Variations each only see the properties meant for them.
  const attributeProperties = useMemo(
    () => properties.filter((p) => p.supportsAttributes),
    [properties],
  );
  const variationProperties = useMemo(
    () => properties.filter((p) => p.supportsVariations),
    [properties],
  );

  function togglePropertyValue(
    prop: TaxonomyProperty,
    pv: { valueId: number | null; name: string },
  ) {
    if (pv.valueId == null) return;
    const current = value.properties[prop.propertyId];
    const idx = current?.valueIds.indexOf(pv.valueId) ?? -1;
    let nextIds: number[];
    let nextValues: string[];
    if (idx >= 0 && current) {
      nextIds = current.valueIds.filter((_, i) => i !== idx);
      nextValues = current.values.filter((_, i) => i !== idx);
    } else if (prop.isMultivalued) {
      const cap = prop.maxValuesAllowed ?? Infinity;
      if ((current?.valueIds.length ?? 0) >= cap) return;
      nextIds = [...(current?.valueIds ?? []), pv.valueId];
      nextValues = [...(current?.values ?? []), pv.name];
    } else {
      nextIds = [pv.valueId];
      nextValues = [pv.name];
    }
    const nextProperties = { ...value.properties };
    if (nextIds.length === 0) delete nextProperties[prop.propertyId];
    else nextProperties[prop.propertyId] = { name: prop.displayName, valueIds: nextIds, values: nextValues };
    patch({ properties: nextProperties });
  }

  // ---- shop sections ----
  const [sections, setSections] = useState<ShopSectionOption[] | null>(null);
  const [sectionsError, setSectionsError] = useState<string | null>(null);
  useEffect(() => {
    fetch("/api/etsy/sections")
      .then(async (res) => {
        const body = (await res.json().catch(() => null)) as
          | { sections?: ShopSectionOption[]; error?: string }
          | null;
        if (!res.ok) {
          throw new Error(res.status === 429 ? RATE_LIMIT_MESSAGE : body?.error || `Request failed (${res.status})`);
        }
        setSections(body?.sections ?? []);
      })
      .catch((err) => {
        setSections([]);
        setSectionsError(err instanceof Error ? err.message : "Could not load sections.");
      });
  }, []);

  // ---- processing profiles (readiness states) ----
  const [processingProfiles, setProcessingProfiles] = useState<ProcessingProfileOption[] | null>(null);
  const [processingProfilesError, setProcessingProfilesError] = useState<string | null>(null);
  useEffect(() => {
    fetch("/api/etsy/processing-profiles")
      .then(async (res) => {
        const body = (await res.json().catch(() => null)) as
          | { profiles?: ProcessingProfileOption[]; error?: string }
          | null;
        if (!res.ok) {
          throw new Error(res.status === 429 ? RATE_LIMIT_MESSAGE : body?.error || `Request failed (${res.status})`);
        }
        setProcessingProfiles(body?.profiles ?? []);
      })
      .catch((err) => {
        setProcessingProfiles([]);
        setProcessingProfilesError(
          err instanceof Error ? err.message : "Could not load processing profiles.",
        );
      });
  }, []);

  // ---- production partners (How it's made) ----
  const [productionPartners, setProductionPartners] = useState<ProductionPartnerOption[] | null>(null);
  const [productionPartnersError, setProductionPartnersError] = useState<string | null>(null);
  useEffect(() => {
    fetch("/api/etsy/production-partners")
      .then(async (res) => {
        const body = (await res.json().catch(() => null)) as
          | { partners?: ProductionPartnerOption[]; error?: string }
          | null;
        if (!res.ok) {
          throw new Error(res.status === 429 ? RATE_LIMIT_MESSAGE : body?.error || `Request failed (${res.status})`);
        }
        setProductionPartners(body?.partners ?? []);
      })
      .catch((err) => {
        setProductionPartners([]);
        setProductionPartnersError(
          err instanceof Error ? err.message : "Could not load production partners.",
        );
      });
  }, []);

  function toggleProductionPartner(id: number) {
    const next = value.productionPartnerIds.includes(id)
      ? value.productionPartnerIds.filter((x) => x !== id)
      : [...value.productionPartnerIds, id];
    patch({ productionPartnerIds: next });
  }

  const inputCls =
    "w-full rounded-lg border border-black/10 bg-white px-3 text-sm outline-none focus:border-primary dark:border-white/15 dark:bg-zinc-950";

  // Once price varies by at least one variation, it's entered per combination
  // on the Variations tab instead — the main-form field is hidden (not
  // deleted) rather than fought over with the combination grid.
  const priceVariesByVariation =
    value.variationToggles.price.enabled && value.variationToggles.price.appliesTo.length > 0;

  // Live preview of the same check `publishToEtsy` runs before sending anything to
  // Etsy — lets the user see and fix a rejected combination right on this tab.
  const howMadeError = howItsMadeError({
    whoMade: value.whoMade,
    isSupply: value.isSupply,
    whenMade: value.whenMade,
    productionPartnerIds: value.productionPartnerIds,
  });

  return (
    <>
      <EditorSectionCard section="title" className="space-y-4">
        <label className="block text-sm">
          <span className="flex justify-between text-xs text-zinc-500">
            <span>Title</span>
            <span className="font-mono">
              {value.title.length}/{MAX_TITLE_LENGTH}
            </span>
          </span>
          <input
            type="text"
            value={value.title}
            maxLength={MAX_TITLE_LENGTH}
            onChange={(e) => patch({ title: e.target.value })}
            placeholder="e.g. Miami Skyline Wall Art Print"
            className={`${inputCls} mt-1 h-10`}
          />
        </label>
      </EditorSectionCard>

      <EditorSectionCard section="description" className="space-y-4">
        <label className="block text-sm">
          <span className="text-xs text-zinc-500">Description</span>
          <textarea
            rows={8}
            value={value.description}
            onChange={(e) => patch({ description: e.target.value })}
            placeholder="Describe the product…"
            className={`${inputCls} mt-1 resize-y py-2`}
          />
        </label>
      </EditorSectionCard>

      <EditorSectionCard section="tags" className="space-y-2">
        <div className="text-sm">
          <span className="flex justify-between text-xs text-zinc-500">
            <span>Tags</span>
            <span className="flex items-center gap-2">
              {value.tags.length > 0 && (
                <button
                  type="button"
                  onClick={() => patch({ tags: [] })}
                  className="text-zinc-500 hover:text-red-600"
                >
                  Delete all
                </button>
              )}
              <span className="font-mono">
                {value.tags.length}/{MAX_TAGS}
              </span>
            </span>
          </span>
          <div className="mt-1 flex flex-wrap items-center gap-1.5 rounded-lg border border-black/10 p-1.5 dark:border-white/15">
            {value.tags.map((t) => (
              <span
                key={t}
                className="flex items-center gap-1 rounded-full bg-black/[.06] px-2 py-0.5 text-xs dark:bg-white/10"
              >
                {t}
                <button
                  type="button"
                  onClick={() => removeTag(t)}
                  aria-label={`Remove ${t} tag`}
                  className="text-zinc-500 hover:text-red-600"
                >
                  ×
                </button>
              </span>
            ))}
            {value.tags.length < MAX_TAGS && (
              <input
                type="text"
                value={tagDraft}
                maxLength={MAX_TAG_LENGTH}
                onChange={(e) => setTagDraft(e.target.value)}
                onPaste={(e) => {
                  const text = e.clipboardData.getData("text");
                  if (!text.includes(",")) return;
                  e.preventDefault();
                  patch({ tags: addCommaSeparated(value.tags, tagDraft + text, MAX_TAGS, MAX_TAG_LENGTH) });
                  setTagDraft("");
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === ",") {
                    e.preventDefault();
                    addTag();
                  }
                }}
                onBlur={addTag}
                placeholder={value.tags.length === 0 ? "Type a tag, press Enter…" : ""}
                className="min-w-[100px] flex-1 border-none bg-transparent px-1 py-0.5 text-sm outline-none"
              />
            )}
          </div>
        </div>
        <div className="text-sm">
          <span className="text-xs text-zinc-500">Materials</span>
          <div className="mt-1 flex flex-wrap items-center gap-1.5 rounded-lg border border-black/10 p-1.5 dark:border-white/15">
            {value.materials.map((m) => (
              <span
                key={m}
                className="flex items-center gap-1 rounded-full bg-black/[.06] px-2 py-0.5 text-xs dark:bg-white/10"
              >
                {m}
                <button
                  type="button"
                  onClick={() => removeMaterial(m)}
                  aria-label={`Remove ${m} material`}
                  className="text-zinc-500 hover:text-red-600"
                >
                  ×
                </button>
              </span>
            ))}
            <input
              type="text"
              aria-label="Add a material"
              value={materialDraft}
              onChange={(e) => setMaterialDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === ",") {
                  e.preventDefault();
                  addMaterial();
                }
              }}
              onBlur={addMaterial}
              placeholder={value.materials.length === 0 ? "Type a material, press Enter…" : ""}
              className="min-w-[100px] flex-1 border-none bg-transparent px-1 py-0.5 text-sm outline-none"
            />
          </div>
        </div>
      </EditorSectionCard>

      <EditorSectionCard section="details" className="space-y-3">
        <div ref={categoryRootRef} className="relative">
          <button
            type="button"
            onClick={() => setCategoryOpen((o) => !o)}
            className={`${inputCls} flex h-10 items-center justify-between text-left`}
          >
            <span className={value.taxonomyPath ? "" : "text-zinc-400"}>
              {value.taxonomyPath || "Select a category…"}
            </span>
            <span className="text-zinc-400">▾</span>
          </button>

          {categoryOpen && (
            <div className="absolute z-10 mt-1 w-full min-w-[280px] overflow-hidden rounded-lg border border-black/10 bg-white shadow-lg dark:border-white/15 dark:bg-zinc-950">
              <div className="border-b border-black/10 p-2 dark:border-white/15">
                <input
                  type="text"
                  autoFocus
                  value={categoryQuery}
                  onChange={(e) => setCategoryQuery(e.target.value)}
                  placeholder="Search categories… (accessories, jewelry, weddings…)"
                  className="h-8 w-full rounded-md border border-black/10 bg-white px-2 text-sm outline-none focus:border-primary dark:border-white/15 dark:bg-zinc-900"
                />
              </div>
              <ul className="max-h-72 overflow-y-auto py-1">
                {taxonomyLoading && (
                  <li className="px-2 py-3 text-center text-xs text-zinc-500">
                    Loading categories…
                  </li>
                )}
                {!taxonomyLoading && categoryRows.length === 0 && (
                  <li className="px-2 py-3 text-center text-xs text-zinc-500">
                    No matching categories.
                  </li>
                )}
                {!taxonomyLoading &&
                  categoryRows.map((n) => (
                    <li key={n.id}>
                      <button
                        type="button"
                        onClick={() => {
                          patch({
                            taxonomyId: n.id,
                            taxonomyPath: n.path,
                            // a new category has different properties (and variations)
                            properties: {},
                            variations: [],
                            variationToggles: EMPTY_VARIATION_TOGGLES,
                            variationRows: EMPTY_VARIATION_ROWS,
                            variationRowEnabled: {},
                            variationPhotos: {},
                          });
                          setCategoryOpen(false);
                          setCategoryQuery("");
                        }}
                        className={`block w-full px-3 py-2 text-left text-sm hover:bg-black/[.04] dark:hover:bg-white/[.06] ${
                          n.id === value.taxonomyId ? "bg-primary/10" : ""
                        }`}
                      >
                        {n.path}
                      </button>
                    </li>
                  ))}
              </ul>
            </div>
          )}
        </div>

        {propertiesLoading && (
          <p className="text-xs text-zinc-500">Loading category properties…</p>
        )}
        {propertiesError && <p className="text-xs text-red-600">{propertiesError}</p>}

        {!propertiesLoading && attributeProperties.length > 0 && (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {attributeProperties.map((prop) => (
              <PropertyPicker
                key={prop.propertyId}
                property={prop}
                selected={value.properties[prop.propertyId]}
                onToggle={togglePropertyValue}
              />
            ))}
          </div>
        )}
      </EditorSectionCard>

      <EditorSectionCard section="howMade" className="max-w-2xl space-y-6">
        <fieldset className="space-y-1.5">
          <legend className="text-xs text-zinc-500">Who made it? *</legend>
          {WHO_MADE_OPTIONS.map((opt) => (
            <label key={opt.value} className="flex items-center gap-2 text-sm">
              <input
                type="radio"
                name="who-made"
                checked={value.whoMade === opt.value}
                onChange={() => patch({ whoMade: opt.value })}
                className="accent-primary"
              />
              {opt.label}
            </label>
          ))}
        </fieldset>

        <fieldset className="space-y-1.5">
          <legend className="text-xs text-zinc-500">What is it? *</legend>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="radio"
              name="is-supply"
              checked={!value.isSupply}
              onChange={() => patch({ isSupply: false })}
              className="accent-primary"
            />
            A finished product
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="radio"
              name="is-supply"
              checked={value.isSupply}
              onChange={() => patch({ isSupply: true })}
              className="accent-primary"
            />
            A supply or tool to make things
          </label>
        </fieldset>

        <label className="block max-w-xs text-sm">
          <span className="text-xs text-zinc-500">When was it made? *</span>
          <select
            value={value.whenMade}
            onChange={(e) => patch({ whenMade: e.target.value as WhenMade })}
            className={`${inputCls} mt-1 h-9`}
          >
            {WHEN_MADE_VALUES.map((v) => (
              <option key={v} value={v}>
                {formatWhenMade(v)}
              </option>
            ))}
          </select>
        </label>

        {value.whoMade === "someone_else" && (
          <div className="space-y-2">
            <span className="block text-xs text-zinc-500">
              Production partners * — required when someone else made this item
            </span>
            {productionPartnersError && (
              <p className="text-xs text-red-600">{productionPartnersError}</p>
            )}
            {productionPartners == null && !productionPartnersError && (
              <p className="text-xs text-zinc-500">Loading production partners…</p>
            )}
            {productionPartners && productionPartners.length === 0 && !productionPartnersError && (
              <p className="text-xs text-zinc-500">
                This shop has no production partners yet.{" "}
                <a
                  href="https://www.etsy.com/your/shops/me/production-partners"
                  target="_blank"
                  rel="noreferrer"
                  className="underline"
                >
                  Add one on Etsy
                </a>
                , then reload this page.
              </p>
            )}
            {productionPartners && productionPartners.length > 0 && (
              <div className="max-h-48 space-y-1 overflow-y-auto rounded-lg border border-black/10 p-2 dark:border-white/15">
                {productionPartners.map((p) => (
                  <label
                    key={p.productionPartnerId}
                    className="flex items-center gap-2 rounded px-1 py-0.5 text-sm hover:bg-black/[.04] dark:hover:bg-white/[.06]"
                  >
                    <input
                      type="checkbox"
                      checked={value.productionPartnerIds.includes(p.productionPartnerId)}
                      onChange={() => toggleProductionPartner(p.productionPartnerId)}
                      className="accent-primary"
                    />
                    {p.partnerName}
                    {p.location && <span className="text-xs text-zinc-500">· {p.location}</span>}
                  </label>
                ))}
              </div>
            )}
          </div>
        )}

        {howMadeError && <p className="text-sm font-medium text-red-600">{howMadeError}</p>}
      </EditorSectionCard>

      <EditorSectionCard section="price" className="max-w-xs space-y-3">
        {priceVariesByVariation ? (
          <p className="text-sm text-zinc-500">
            Price varies by variation — set it per combination on the{" "}
            {onGoToSection ? (
              <button
                type="button"
                onClick={() => onGoToSection("variations")}
                className="font-medium text-primary hover:underline"
              >
                Variations section
              </button>
            ) : (
              "Variations section"
            )}
            .
          </p>
        ) : (
          <label className="block text-sm">
            <span className="text-xs text-zinc-500">Price</span>
            <input
              type="number"
              min="0"
              step="0.01"
              inputMode="decimal"
              value={value.price}
              onChange={(e) => patch({ price: e.target.value })}
              placeholder="0.00"
              className={`${inputCls} mt-1 h-10`}
            />
          </label>
        )}
      </EditorSectionCard>

      <EditorSectionCard section="inventory" className="max-w-md space-y-3">
        <div className="grid grid-cols-2 gap-3 text-sm">
          <label className="block">
            <span className="text-xs text-zinc-500">Quantity</span>
            <input
              type="number"
              min="1"
              step="1"
              inputMode="numeric"
              value={value.quantity}
              onChange={(e) => patch({ quantity: e.target.value })}
              className={`${inputCls} mt-1 h-10`}
            />
          </label>
          <label className="block">
            <span className="text-xs text-zinc-500">SKU</span>
            <input
              type="text"
              value={value.sku}
              onChange={(e) => patch({ sku: e.target.value })}
              placeholder="optional"
              className={`${inputCls} mt-1 h-10`}
            />
          </label>
        </div>
      </EditorSectionCard>

      <VariationsSection
        value={value}
        patch={patch}
        taxonomyTree={taxonomyTree}
        taxonomyError={taxonomyError}
        variationProperties={variationProperties}
        propertiesLoading={propertiesLoading}
        propertiesError={propertiesError}
        processingProfiles={processingProfiles}
        photoSlots={photoSlots}
        currencyCode={currencyCode}
        showErrors={showVariationErrors}
        errorJump={variationErrorJump}
      />

      <PersonalizationSection value={value} patch={patch} />

      <EditorSectionCard section="shipping" className="max-w-md space-y-3">
        {processingProfiles && processingProfiles.length === 0 && !processingProfilesError ? (
          <p className="text-xs text-zinc-500">
            This shop has no processing profile yet — Etsy requires one for every
            physical listing.{" "}
            <a
              href="https://www.etsy.com/your/shops/me/tools/shipping-profiles"
              target="_blank"
              rel="noreferrer"
              className="underline"
            >
              Create one on Etsy
            </a>
            , then reload this page.
          </p>
        ) : (
          <label className="block text-sm">
            <span className="text-xs text-zinc-500">Processing profile</span>
            <select
              value={value.readinessStateId ?? ""}
              onChange={(e) => {
                const id = e.target.value ? Number(e.target.value) : null;
                patch({ readinessStateId: id });
              }}
              className={`${inputCls} mt-1 h-9`}
            >
              <option value="">Select a processing profile…</option>
              {(processingProfiles ?? []).map((p) => (
                <option key={p.readinessStateId} value={p.readinessStateId}>
                  {p.displayLabel || `${p.minProcessingDays}-${p.maxProcessingDays} days`}
                  {" · "}
                  {p.readinessState === "made_to_order" ? "Made to order" : "Ready to ship"}
                </option>
              ))}
            </select>
            {processingProfilesError && (
              <p className="mt-1 text-xs text-red-600">{processingProfilesError}</p>
            )}
          </label>
        )}
      </EditorSectionCard>

      <EditorSectionCard section="settings" className="max-w-md space-y-5">
        <label className="block text-sm">
          <span className="text-xs text-zinc-500">Shop section</span>
          <select
            value={value.shopSectionId ?? ""}
            onChange={(e) => {
              const id = e.target.value ? Number(e.target.value) : null;
              const title = sections?.find((s) => s.shopSectionId === id)?.title ?? "";
              patch({ shopSectionId: id, shopSectionTitle: title });
            }}
            className={`${inputCls} mt-1 h-9`}
          >
            <option value="">No section</option>
            {(sections ?? []).map((s) => (
              <option key={s.shopSectionId} value={s.shopSectionId}>
                {decodeHtmlEntities(s.title)}
              </option>
            ))}
          </select>
          {sectionsError && <p className="mt-1 text-xs text-red-600">{sectionsError}</p>}
          <p className="mt-1 text-xs text-zinc-500">
            Use shop sections to organize your products into groups shoppers can explore.
          </p>
        </label>

        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            checked={value.featureListing}
            onChange={(e) => patch({ featureListing: e.target.checked })}
            className="mt-0.5 accent-primary"
          />
          <span>
            Feature this listing
            <span className="block text-xs text-zinc-500">
              Showcase this listing at the top of your shop home to make it stand out.
            </span>
          </span>
        </label>

        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            checked={value.promoteWithAds}
            onChange={(e) => patch({ promoteWithAds: e.target.checked })}
            className="mt-0.5 accent-primary"
          />
          <span>
            Etsy Ads
            <span className="block text-xs text-zinc-500">
              Promote this listing on Etsy as part of your Etsy Ads campaign.
            </span>
            <span className="block text-xs text-amber-600 dark:text-amber-500">
              Etsy&apos;s Open API has no Ads-campaign endpoint — this isn&apos;t sent anywhere.
              Manage Etsy Ads from your shop&apos;s dashboard on Etsy.com.
            </span>
          </span>
        </label>

        <fieldset className="text-sm">
          <legend className="text-xs text-zinc-500">Renewal options *</legend>
          <div className="mt-1 space-y-1.5">
            <label className="flex items-center gap-2">
              <input
                type="radio"
                name="renewal-option"
                checked={value.autoRenew}
                onChange={() => patch({ autoRenew: true })}
                className="accent-primary"
              />
              Automatic
            </label>
            <label className="flex items-center gap-2">
              <input
                type="radio"
                name="renewal-option"
                checked={!value.autoRenew}
                onChange={() => patch({ autoRenew: false })}
                className="accent-primary"
              />
              Manual
            </label>
          </div>
          <p className="mt-1 text-xs text-zinc-500">
            Each renewal lasts for four months or until the listing sells out.
          </p>
        </fieldset>
      </EditorSectionCard>
    </>
  );
}

/** Rows beyond this are hidden until the search narrows things down. */
const MAX_PROPERTY_ROWS = 50;

/**
 * One category property (materials, primary/secondary colour, size,
 * sustainability, clothing style, occasion, holiday, ...) — every one of them
 * renders through this exact component so a 3-option property and a
 * 500+-option one look identical: fixed-height scrolling list, a search box
 * above it, checkboxes for the options, a summary line below. Single-select
 * properties still use a checkbox (not a radio) for visual consistency, but
 * checking one clears any other selection for that property.
 */
function PropertyPicker({
  property,
  selected,
  onToggle,
}: {
  property: TaxonomyProperty;
  selected: ListingFormProperty | undefined;
  onToggle: (
    property: TaxonomyProperty,
    value: { valueId: number | null; name: string },
  ) => void;
}) {
  const [query, setQuery] = useState("");
  const pickedIds = selected?.valueIds ?? [];

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    const all = property.possibleValues;
    const filtered = q
      ? all.filter((pv) => pv.name.toLowerCase().includes(q))
      : all;
    return filtered.slice(0, MAX_PROPERTY_ROWS);
  }, [property.possibleValues, query]);

  return (
    <div>
      <span className="text-xs text-zinc-500">
        {property.displayName}
        {property.isRequired ? " *" : ""}
      </span>

      <div className="mt-1 overflow-hidden rounded-lg border border-black/10 dark:border-white/15">
        <div className="border-b border-black/10 p-1.5 dark:border-white/15">
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search…"
            className="h-7 w-full rounded-md bg-transparent px-1.5 text-xs outline-none"
          />
        </div>
        <div className="h-36 overflow-y-auto p-1">
          {rows.length === 0 && (
            <p className="px-2 py-3 text-center text-xs text-zinc-400">No results.</p>
          )}
          {rows.map((pv) => {
            const checked = pv.valueId != null && pickedIds.includes(pv.valueId);
            return (
              <label
                key={pv.valueId ?? pv.name}
                className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-xs hover:bg-black/[.04] dark:hover:bg-white/[.06]"
              >
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => onToggle(property, pv)}
                  className="accent-primary"
                />
                {pv.name}
              </label>
            );
          })}
        </div>
      </div>

      <p className="mt-1 truncate text-xs text-zinc-600 dark:text-zinc-400">
        <span className="font-medium">Selected:</span>{" "}
        {selected?.values.length ? selected.values.join(", ") : "—"}
      </p>
    </div>
  );
}

interface CustomOption {
  /** Assigned once when the option is added, never recomputed from position — see {@link ListingFormVariation.valueIds}. */
  id: number;
  text: string;
}

/**
 * Options editor for a custom variation — full-width rows in display order
 * (the order shown here is what buyers see), each with a drag handle,
 * inline-editable text, and delete. Renaming or reordering an option keeps
 * its id (and therefore every combination value already entered against
 * it); only deleting one drops its id for good.
 */
function CustomOptionsInput({
  options,
  onChange,
}: {
  options: CustomOption[];
  onChange: (options: CustomOption[]) => void;
}) {
  const [draft, setDraft] = useState("");
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editingText, setEditingText] = useState("");
  const [dragIndex, setDragIndex] = useState<number | null>(null);

  function add() {
    const t = draft.trim();
    if (!t) return;
    if (options.some((o) => o.text.toLowerCase() === t.toLowerCase())) {
      setDraft("");
      return;
    }
    const nextId = Math.max(0, ...options.map((o) => o.id)) + 1;
    onChange([...options, { id: nextId, text: t }]);
    setDraft("");
  }
  function remove(id: number) {
    onChange(options.filter((o) => o.id !== id));
  }
  function move(from: number, to: number) {
    if (from === to || to < 0 || to >= options.length) return;
    const next = [...options];
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item);
    onChange(next);
  }
  function startRename(o: CustomOption) {
    setEditingId(o.id);
    setEditingText(o.text);
  }
  function commitRename() {
    const t = editingText.trim();
    if (editingId != null && t) {
      onChange(options.map((o) => (o.id === editingId ? { ...o, text: t } : o)));
    }
    setEditingId(null);
  }

  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        <input
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add();
            }
          }}
          placeholder="Enter an option…"
          className="h-9 flex-1 rounded-lg border border-black/10 bg-white px-2 text-sm outline-none focus:border-primary dark:border-white/15 dark:bg-zinc-950"
        />
        <button
          type="button"
          onClick={add}
          disabled={!draft.trim()}
          className="h-9 rounded-lg border border-black/10 px-3 text-sm font-medium hover:bg-black/[.04] disabled:cursor-not-allowed disabled:opacity-40 dark:border-white/15 dark:hover:bg-white/[.06]"
        >
          Add
        </button>
      </div>

      <div className="space-y-1">
        {options.map((o, i) => (
          <div
            key={o.id}
            draggable
            onDragStart={(e) => {
              e.dataTransfer.effectAllowed = "move";
              e.dataTransfer.setData("text/plain", String(i));
              setDragIndex(i);
            }}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              const from = Number(e.dataTransfer.getData("text/plain"));
              if (Number.isFinite(from)) move(from, i);
              setDragIndex(null);
            }}
            onDragEnd={() => setDragIndex(null)}
            className={`flex items-center gap-2 rounded-lg border border-black/10 px-2 py-1.5 dark:border-white/15 ${
              dragIndex === i ? "opacity-50" : ""
            }`}
          >
            <span className="cursor-grab select-none text-zinc-400" aria-hidden="true">
              ⠿
            </span>
            {editingId === o.id ? (
              <input
                autoFocus
                type="text"
                value={editingText}
                onChange={(e) => setEditingText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    commitRename();
                  }
                  if (e.key === "Escape") setEditingId(null);
                }}
                onBlur={commitRename}
                className="h-7 flex-1 rounded border border-black/10 bg-white px-1.5 text-sm outline-none focus:border-primary dark:border-white/15 dark:bg-zinc-900"
              />
            ) : (
              <span className="flex-1 truncate text-sm">{o.text}</span>
            )}
            <button
              type="button"
              onClick={() => startRename(o)}
              aria-label={`Rename ${o.text}`}
              className="shrink-0 text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200"
            >
              ✎
            </button>
            <button
              type="button"
              onClick={() => remove(o.id)}
              aria-label={`Delete ${o.text} option`}
              className="shrink-0 text-zinc-500 hover:text-red-600"
            >
              🗑
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
// ---------------------------------------------------------------------------
// Personalization — two independent, fully editable question slots (Etsy
// allows up to 5; this tab offers 2, matching Vela's layout). The first slot
// is always shown; the second starts collapsed behind "No second
// personalization" until explicitly added. Clearing a slot's label excludes
// it from the listing entirely — nothing is ever locked once configured.
// ---------------------------------------------------------------------------

const personalizationInputCls =
  "mt-1 h-9 w-full rounded-lg border border-black/10 bg-white px-2 text-sm outline-none focus:border-primary dark:border-white/15 dark:bg-zinc-950";

function PersonalizationSection({
  value,
  patch,
}: {
  value: ListingFormValue;
  patch: (partial: Partial<ListingFormValue>) => void;
}) {
  const slot0 = value.personalizationQuestions[0] ?? EMPTY_PERSONALIZATION_QUESTION;
  const slot1 = value.personalizationQuestions[1] ?? null;

  function setSlot0(q: PersonalizationQuestionInput) {
    patch({ personalizationQuestions: slot1 ? [q, slot1] : [q] });
  }
  function setSlot1(q: PersonalizationQuestionInput) {
    patch({ personalizationQuestions: [slot0, q] });
  }
  function addSlot1() {
    patch({ personalizationQuestions: [slot0, EMPTY_PERSONALIZATION_QUESTION] });
  }
  function removeSlot1() {
    patch({ personalizationQuestions: [slot0] });
  }

  return (
    <EditorSectionCard section="personalization" className="max-w-2xl space-y-6">
      <p className="text-sm text-zinc-500">
        Let buyers customize this listing — a text box, a list of options, or a file upload.
        Etsy allows up to {PERSONALIZATION_MAX_QUESTIONS} personalization questions per listing;
        this form offers 2.
      </p>

      <PersonalizationFieldEditor index={0} question={slot0} onChange={setSlot0} />

      {slot1 ? (
        <PersonalizationFieldEditor index={1} question={slot1} onChange={setSlot1} onRemove={removeSlot1} />
      ) : (
        <div className="flex items-center justify-between rounded-lg border border-dashed border-black/20 px-4 py-3 dark:border-white/25">
          <span className="text-sm text-zinc-500">No second personalization</span>
          <button
            type="button"
            onClick={addSlot1}
            className="h-8 rounded-full border border-black/10 px-3 text-xs font-medium hover:bg-black/[.04] dark:border-white/15 dark:hover:bg-white/[.06]"
          >
            + Add second personalization
          </button>
        </div>
      )}
    </EditorSectionCard>
  );
}

function PersonalizationFieldEditor({
  index,
  question,
  onChange,
  onRemove,
}: {
  index: number;
  question: PersonalizationQuestionInput;
  onChange: (q: PersonalizationQuestionInput) => void;
  /** Omitted for the first (always-present) slot. */
  onRemove?: () => void;
}) {
  const error = question.questionText.trim()
    ? personalizationQuestionError(question, `Personalization ${index + 1}`)
    : null;

  function patchQuestion(partial: Partial<PersonalizationQuestionInput>) {
    onChange({ ...question, ...partial });
  }

  // Switching type resets the type-specific sub-fields to sensible defaults,
  // so stale state from a previously chosen type is never silently sent.
  function setFieldType(fieldType: PersonalizationFieldType) {
    onChange({
      ...question,
      fieldType,
      instructions: fieldType === "dropdown" ? "" : question.instructions,
      maxAllowedCharacters:
        fieldType === "text_input" ? question.maxAllowedCharacters || 50 : question.maxAllowedCharacters,
      maxAllowedFiles:
        fieldType === "unlabeled_upload" ? question.maxAllowedFiles || 1 : question.maxAllowedFiles,
      options: fieldType === "dropdown" ? question.options : [],
    });
  }

  return (
    <div className="space-y-3 rounded-lg border border-black/10 p-4 dark:border-white/15">
      <div className="flex items-start justify-between gap-2">
        <label className="block max-w-xs flex-1 text-sm">
          <span className="text-xs text-zinc-500">Choose field type</span>
          <select
            value={question.fieldType}
            onChange={(e) => setFieldType(e.target.value as PersonalizationFieldType)}
            className={personalizationInputCls}
          >
            {PERSONALIZATION_FIELD_TYPES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
        </label>
        {onRemove && (
          <button
            type="button"
            onClick={onRemove}
            className="mt-5 shrink-0 text-xs font-medium text-red-600 hover:underline"
          >
            Remove
          </button>
        )}
      </div>

      <label className="block text-sm">
        <span className="flex justify-between text-xs text-zinc-500">
          <span>Label shown to the buyer</span>
          <span className="font-mono">
            {question.questionText.length}/{PERSONALIZATION_QUESTION_TEXT_MAX}
          </span>
        </span>
        <input
          type="text"
          value={question.questionText}
          maxLength={PERSONALIZATION_QUESTION_TEXT_MAX}
          onChange={(e) => patchQuestion({ questionText: e.target.value })}
          placeholder="e.g. What name would you like engraved?"
          className={personalizationInputCls}
        />
      </label>

      {question.fieldType !== "dropdown" && (
        <label className="block text-sm">
          <span className="flex justify-between text-xs text-zinc-500">
            <span>Instructions for the buyer (optional)</span>
            <span className="font-mono">
              {question.instructions.length}/{PERSONALIZATION_INSTRUCTIONS_MAX}
            </span>
          </span>
          <input
            type="text"
            value={question.instructions}
            maxLength={PERSONALIZATION_INSTRUCTIONS_MAX}
            onChange={(e) => patchQuestion({ instructions: e.target.value })}
            placeholder="e.g. Please enter the name exactly as it should appear"
            className={personalizationInputCls}
          />
        </label>
      )}

      {question.fieldType === "text_input" && (
        <label className="block max-w-[240px] text-sm">
          <span className="text-xs text-zinc-500">
            Max characters (Etsy allows {PERSONALIZATION_CHAR_COUNT_MIN}–{PERSONALIZATION_CHAR_COUNT_MAX})
          </span>
          <input
            type="number"
            min={PERSONALIZATION_CHAR_COUNT_MIN}
            max={PERSONALIZATION_CHAR_COUNT_MAX}
            value={question.maxAllowedCharacters}
            onChange={(e) => patchQuestion({ maxAllowedCharacters: Number(e.target.value) })}
            className={personalizationInputCls}
          />
        </label>
      )}

      {question.fieldType === "unlabeled_upload" && (
        <label className="block max-w-[240px] text-sm">
          <span className="text-xs text-zinc-500">
            Max files (Etsy allows {PERSONALIZATION_MAX_FILES_MIN}–{PERSONALIZATION_MAX_FILES_MAX})
          </span>
          <input
            type="number"
            min={PERSONALIZATION_MAX_FILES_MIN}
            max={PERSONALIZATION_MAX_FILES_MAX}
            value={question.maxAllowedFiles}
            onChange={(e) => patchQuestion({ maxAllowedFiles: Number(e.target.value) })}
            className={personalizationInputCls}
          />
        </label>
      )}

      {question.fieldType === "dropdown" && (
        <div>
          <span className="text-xs text-zinc-500">
            Options (1–{PERSONALIZATION_MAX_OPTIONS}, each up to {PERSONALIZATION_OPTION_LABEL_MAX} characters)
          </span>
          <div className="mt-1">
            <CustomOptionsInput
              options={question.options.map((text, id) => ({ id, text }))}
              onChange={(options) => patchQuestion({ options: options.map((o) => o.text) })}
            />
          </div>
        </div>
      )}

      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={question.required}
          onChange={(e) => patchQuestion({ required: e.target.checked })}
          className="accent-primary"
        />
        Required
      </label>

      {error && <p className="text-xs font-medium text-red-600">{error}</p>}
    </div>
  );
}
