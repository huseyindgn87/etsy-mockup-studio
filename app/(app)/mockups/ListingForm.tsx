"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  MAX_OPTIONS_PER_VARIATION,
  MAX_VARIATIONS,
  maxCombinationsFor,
} from "@/lib/etsy/variation-limits";
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
import { applyPriceAdjustment, parsePriceAdjustment } from "@/lib/etsy/price-adjustment";

/** The shape this form edits — read by the page when publishing `mode: "new"`. */
export interface ListingFormProperty {
  name: string;
  valueIds: number[];
  values: string[];
  scaleId?: number | null;
}

/** Etsy's three reserved "Custom Variation" property slots — no taxonomy entry, user-named. */
const CUSTOM_PROPERTY_IDS = [513, 514, 516] as const;

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
}

export type VariationToggleKey = "price" | "readiness" | "quantity" | "sku";

/** One tab of the left-nav listing editor that this form's fields live in. */
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
  variationToggles: EMPTY_VARIATION_TOGGLES,
  variationRows: EMPTY_VARIATION_ROWS,
  variationRowEnabled: {},
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
 * properties + section, price, quantity/SKU, and variations — one left-nav
 * tab's worth of fields rendered at a time (`activeTab`, or nothing when
 * `null`, e.g. while a non-form tab like Photos is active). All fields'
 * fetch effects and local state stay mounted regardless of which tab is
 * showing, so switching tabs never drops in-flight data or re-fetches
 * taxonomy/sections. Values feed a draft listing on publish; nothing here is
 * sent to Etsy until then.
 */
export default function ListingForm({
  value,
  onChange,
  activeTab,
  onGoToTab,
}: {
  value: ListingFormValue;
  onChange: (next: ListingFormValue) => void;
  activeTab: ListingFormTab | null;
  /** Lets a sub-panel (e.g. the Variations modal) send the user to another tab, such as Details to pick a category. */
  onGoToTab?: (tab: ListingFormTab) => void;
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

  // ---- category picker ----
  const [categoryOpen, setCategoryOpen] = useState(false);
  const [categoryQuery, setCategoryQuery] = useState("");
  const [taxonomy, setTaxonomy] = useState<FlatTaxonomyNode[] | null>(null);
  const [taxonomyLoading, setTaxonomyLoading] = useState(false);
  const categoryRootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!categoryOpen || taxonomy || taxonomyLoading) return;
    // Kicking off the fetch: an intentional synchronous "start loading" flag.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setTaxonomyLoading(true);
    fetch("/api/etsy/taxonomy")
      .then((res) => (res.ok ? res.json() : null))
      .then((body: { tree?: TaxonomyNode[] } | null) => {
        setTaxonomy(flattenTaxonomy(body?.tree ?? []));
      })
      .catch(() => setTaxonomy([]))
      .finally(() => setTaxonomyLoading(false));
  }, [categoryOpen, taxonomy, taxonomyLoading]);

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
    "w-full rounded-lg border border-black/10 bg-white px-3 text-sm outline-none focus:border-[#f56400] dark:border-white/15 dark:bg-zinc-950";
  const sectionHeadingCls = "text-base font-bold text-zinc-900 dark:text-zinc-50";

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

  if (activeTab === null) return null;

  return (
    <>
      {activeTab === "title" && (
        <section className="space-y-4">
          <h3 className={sectionHeadingCls}>Title</h3>
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
        </section>
      )}

      {activeTab === "description" && (
        <section className="space-y-4">
          <h3 className={sectionHeadingCls}>Description</h3>
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
        </section>
      )}

      {activeTab === "tags" && (
        <section className="space-y-2">
          <h3 className={sectionHeadingCls}>Tags</h3>
          <div className="text-sm">
            <span className="flex justify-between text-xs text-zinc-500">
              <span>Tags</span>
              <span className="font-mono">
                {value.tags.length}/{MAX_TAGS}
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
        </section>
      )}

      {activeTab === "details" && (
        <section className="space-y-3">
          <h3 className={sectionHeadingCls}>Details</h3>

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
                    className="h-8 w-full rounded-md border border-black/10 bg-white px-2 text-sm outline-none focus:border-[#f56400] dark:border-white/15 dark:bg-zinc-900"
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
                            });
                            setCategoryOpen(false);
                            setCategoryQuery("");
                          }}
                          className={`block w-full px-3 py-2 text-left text-sm hover:bg-black/[.04] dark:hover:bg-white/[.06] ${
                            n.id === value.taxonomyId ? "bg-[#f56400]/10" : ""
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
        </section>
      )}

      {activeTab === "howMade" && (
        <section className="max-w-2xl space-y-6">
          <h3 className={sectionHeadingCls}>How it&apos;s made</h3>

          <fieldset className="space-y-1.5">
            <legend className="text-xs text-zinc-500">Who made it? *</legend>
            {WHO_MADE_OPTIONS.map((opt) => (
              <label key={opt.value} className="flex items-center gap-2 text-sm">
                <input
                  type="radio"
                  name="who-made"
                  checked={value.whoMade === opt.value}
                  onChange={() => patch({ whoMade: opt.value })}
                  className="accent-[#f56400]"
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
                className="accent-[#f56400]"
              />
              A finished product
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="radio"
                name="is-supply"
                checked={value.isSupply}
                onChange={() => patch({ isSupply: true })}
                className="accent-[#f56400]"
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
                        className="accent-[#f56400]"
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
        </section>
      )}

      {activeTab === "price" && (
        <section className="max-w-xs space-y-3">
          <h3 className={sectionHeadingCls}>Price</h3>
          {priceVariesByVariation ? (
            <p className="text-sm text-zinc-500">
              Price varies by variation — set it per combination on the{" "}
              {onGoToTab ? (
                <button
                  type="button"
                  onClick={() => onGoToTab("variations")}
                  className="font-medium text-[#f56400] hover:underline"
                >
                  Variations tab
                </button>
              ) : (
                "Variations tab"
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
        </section>
      )}

      {activeTab === "inventory" && (
        <section className="max-w-md space-y-3">
          <h3 className={sectionHeadingCls}>Inventory</h3>
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
        </section>
      )}

      {activeTab === "variations" && (
        <VariationsSection
          variationProperties={variationProperties}
          propertiesLoading={propertiesLoading}
          propertiesError={propertiesError}
          value={value}
          patch={patch}
          sectionHeadingCls={sectionHeadingCls}
          onGoToTab={onGoToTab}
        />
      )}

      {activeTab === "personalization" && (
        <PersonalizationSection value={value} patch={patch} sectionHeadingCls={sectionHeadingCls} />
      )}

      {activeTab === "shipping" && (
        <section className="max-w-md space-y-3">
          <h3 className={sectionHeadingCls}>Shipping</h3>

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
        </section>
      )}

      {activeTab === "settings" && (
        <section className="max-w-md space-y-5">
          <h3 className={sectionHeadingCls}>Settings</h3>

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
              className="mt-0.5 accent-[#f56400]"
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
              className="mt-0.5 accent-[#f56400]"
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
                  className="accent-[#f56400]"
                />
                Automatic
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="radio"
                  name="renewal-option"
                  checked={!value.autoRenew}
                  onChange={() => patch({ autoRenew: false })}
                  className="accent-[#f56400]"
                />
                Manual
              </label>
            </div>
            <p className="mt-1 text-xs text-zinc-500">
              Each renewal lasts for four months or until the listing sells out.
            </p>
          </fieldset>
        </section>
      )}
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
                  className="accent-[#f56400]"
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

// ---------------------------------------------------------------------------
// Variations — the variation list, vary-by toggles, counters, bulk
// enable/disable controls and the full combination grid all live directly on
// this tab (VariationsSection), edited straight onto the shared form value
// like every other tab. A modal (VariationEditorModal) is used only to add or
// edit a single variation: a property picker (an Etsy taxonomy property or
// "Create your own"), then a value picker (a scale selector when the
// property has one, predefined values as checkboxes, plus free-text
// additions) or the custom-variation editor. Saving or deleting a variation
// there closes the modal and returns to the page.
// ---------------------------------------------------------------------------

interface VariationCombo {
  valueIds: number[];
  values: string[];
}

const VARIATION_TOGGLES: { key: VariationToggleKey; label: string }[] = [
  { key: "price", label: "Vary by price" },
  { key: "readiness", label: "Vary by processing profile" },
  { key: "quantity", label: "Vary by quantity" },
  { key: "sku", label: "Vary by SKU" },
];
const VARIATION_COLUMN_LABEL: Record<VariationToggleKey, string> = {
  price: "Price",
  readiness: "Processing profile",
  quantity: "Quantity",
  sku: "SKU",
};

/** The joined value ids a field's `appliesTo`-scoped subset of one combination — its table-cell/state key. */
function comboKeyFor(appliesTo: number[], combo: VariationCombo): string {
  return appliesTo.map((i) => combo.valueIds[i]).join(":");
}

/** Every value id in a combination, joined — its `variationRowEnabled` key (matches `ListingFormValue`'s own key). */
function fullComboKey(combo: VariationCombo): string {
  return combo.valueIds.join(":");
}

/** 513/514 for the first two custom variations, 516 for a third. */
function nextCustomPropertyId(variations: ListingFormVariation[], editingIndex: number | null): number {
  const used = new Set(
    variations.filter((_, i) => i !== editingIndex).filter((v) => v.isCustom).map((v) => v.propertyId),
  );
  return CUSTOM_PROPERTY_IDS.find((id) => !used.has(id)) ?? CUSTOM_PROPERTY_IDS[0];
}

/** Drop an `appliesTo` reference to a removed variation index and shift what's left down. */
function reindexAppliesTo(appliesTo: number[], removedIndex: number): number[] {
  return appliesTo.filter((i) => i !== removedIndex).map((i) => (i > removedIndex ? i - 1 : i));
}

/** The total option-combination count for a set of variations (0 when there are none). */
function totalCombinationsFor(variations: ListingFormVariation[]): number {
  if (variations.length === 0) return 0;
  return variations.reduce((acc, v) => acc * Math.max(v.valueIds.length, 1), 1);
}

/**
 * The Variations tab itself: the variation list, vary-by toggles, counters,
 * bulk enable/disable controls and the full combination grid, all editing
 * the shared form value directly (no draft, no "Apply" — every change here
 * takes effect immediately, same as every other tab). Adding or editing one
 * variation opens {@link VariationEditorModal}; everything else stays here.
 */
function VariationsSection({
  variationProperties,
  propertiesLoading,
  propertiesError,
  value,
  patch,
  sectionHeadingCls,
  onGoToTab,
}: {
  variationProperties: TaxonomyProperty[];
  propertiesLoading: boolean;
  propertiesError: string | null;
  value: ListingFormValue;
  patch: (partial: Partial<ListingFormValue>) => void;
  sectionHeadingCls: string;
  onGoToTab?: (tab: ListingFormTab) => void;
}) {
  const [editor, setEditor] = useState<{ mode: "add" } | { mode: "edit"; index: number } | null>(null);

  const variations = value.variations;
  const toggles = value.variationToggles;

  // Analytical counts — cheap even when the real combinations count is too
  // large to materialize, so the limit checks below never need the full grid.
  const oversizedVariation = variations.find((v) => v.values.length > MAX_OPTIONS_PER_VARIATION) ?? null;
  const totalCombinations = totalCombinationsFor(variations);
  // Etsy drops the usual combination cap to 400 the moment ANY *_on_property
  // field (price/quantity/SKU/processing-profile) is bound to every
  // configured variation type.
  const anyFieldBoundToAllVariations = (["price", "quantity", "sku", "readiness"] as const).some((k) => {
    const t = toggles[k];
    return t.enabled && variations.length > 0 && new Set(t.appliesTo).size >= variations.length;
  });
  const combinationsCap = maxCombinationsFor(variations.length, anyFieldBoundToAllVariations);

  const violation: string | null = oversizedVariation
    ? `"${oversizedVariation.name}" has ${oversizedVariation.values.length} options — Etsy allows at most ${MAX_OPTIONS_PER_VARIATION} per variation type.`
    : totalCombinations > combinationsCap
      ? `${totalCombinations} combinations exceeds Etsy's limit of ${combinationsCap}${
          anyFieldBoundToAllVariations
            ? " (a price/quantity/SKU/processing-profile field varies by every option, which drops the limit to 400)"
            : ""
        }.`
      : null;

  const combos = useMemo<VariationCombo[]>(() => {
    if (variations.length === 0 || violation) return [];
    let acc: VariationCombo[] = [{ valueIds: [], values: [] }];
    for (const v of variations) {
      const next: VariationCombo[] = [];
      for (const a of acc) {
        for (let i = 0; i < v.valueIds.length; i++) {
          next.push({ valueIds: [...a.valueIds, v.valueIds[i]], values: [...a.values, v.values[i]] });
        }
      }
      acc = next;
    }
    return acc;
  }, [variations, violation]);

  const disabledCount = combos.filter((c) => value.variationRowEnabled[fullComboKey(c)] === false).length;

  function setToggle(key: VariationToggleKey, partial: Partial<VariationToggleState>) {
    patch({ variationToggles: { ...toggles, [key]: { ...toggles[key], ...partial } } });
  }
  function patchCell(key: VariationToggleKey, cellKey: string, val: string) {
    patch({
      variationRows: { ...value.variationRows, [key]: { ...value.variationRows[key], [cellKey]: val } },
    });
  }
  function applyBulkFill(key: VariationToggleKey, val: string) {
    if (!val.trim()) return;
    const keys = new Set(combos.map((c) => comboKeyFor(toggles[key].appliesTo, c)));
    const nextCol = { ...value.variationRows[key] };
    for (const k of keys) nextCol[k] = val;
    patch({ variationRows: { ...value.variationRows, [key]: nextCol } });
  }
  /** Merges several cell updates into one column in a single patch — needed whenever more than one cell is written at once (see applyBulkFill above), since patchCell alone would have each call clobber the last. */
  function patchCells(key: VariationToggleKey, updates: Record<string, string>) {
    patch({ variationRows: { ...value.variationRows, [key]: { ...value.variationRows[key], ...updates } } });
  }
  function setRowsEnabled(keys: string[], enabled: boolean) {
    const next = { ...value.variationRowEnabled };
    for (const k of keys) {
      if (enabled) delete next[k];
      else next[k] = false;
    }
    patch({ variationRowEnabled: next });
  }
  function removeVariation(i: number) {
    const nextVariations = variations.filter((_, idx) => idx !== i);
    const nextToggles = { ...toggles };
    for (const key of Object.keys(nextToggles) as VariationToggleKey[]) {
      const t = nextToggles[key];
      const appliesTo = reindexAppliesTo(t.appliesTo, i);
      nextToggles[key] = { enabled: t.enabled && appliesTo.length > 0, appliesTo };
    }
    patch({ variations: nextVariations, variationToggles: nextToggles });
  }

  return (
    <section className="space-y-4">
      <h3 className={sectionHeadingCls}>Variations</h3>

      {variations.length === 0 ? (
        <div className="flex items-center justify-center rounded-lg border border-dashed border-black/20 py-10 dark:border-white/25">
          <button
            type="button"
            onClick={() => setEditor({ mode: "add" })}
            className="h-9 rounded-lg bg-[#f56400] px-4 text-sm font-medium text-white hover:bg-[#d95700]"
          >
            Add variation
          </button>
        </div>
      ) : (
        <>
          <div className="space-y-2">
            {variations.map((v, i) => (
              <VariationCard
                key={i}
                variation={v}
                onEdit={() => setEditor({ mode: "edit", index: i })}
                onDelete={() => removeVariation(i)}
              />
            ))}
          </div>

          {variations.length < MAX_VARIATIONS && (
            <button
              type="button"
              onClick={() => setEditor({ mode: "add" })}
              className="h-9 rounded-lg border border-dashed border-black/20 px-3 text-sm text-zinc-600 hover:bg-black/[.04] dark:border-white/25 dark:text-zinc-300 dark:hover:bg-white/[.06]"
            >
              Add variation
            </button>
          )}

          <div className="space-y-2 rounded-lg border border-black/10 p-4 dark:border-white/15">
            {VARIATION_TOGGLES.map(({ key, label }) => {
              const t = toggles[key];
              return (
                <div key={key} className="flex flex-wrap items-center gap-2">
                  <label className="flex items-center gap-1.5 text-sm">
                    <input
                      type="checkbox"
                      checked={t.enabled}
                      onChange={(e) => {
                        const enabled = e.target.checked;
                        setToggle(key, {
                          enabled,
                          appliesTo:
                            enabled && t.appliesTo.length === 0 ? variations.map((_, i) => i) : t.appliesTo,
                        });
                      }}
                      className="accent-[#f56400]"
                    />
                    {label}
                  </label>
                  {t.enabled && variations.length > 1 && (
                    <div className="flex flex-wrap items-center gap-2">
                      {variations.map((v, i) => (
                        <label key={i} className="flex items-center gap-1 text-xs text-zinc-600 dark:text-zinc-400">
                          <input
                            type="checkbox"
                            checked={t.appliesTo.includes(i)}
                            onChange={(e) => {
                              const next = e.target.checked
                                ? [...t.appliesTo, i]
                                : t.appliesTo.filter((x) => x !== i);
                              if (next.length > 0) setToggle(key, { appliesTo: next });
                            }}
                            className="accent-[#f56400]"
                          />
                          {v.name}
                        </label>
                      ))}
                    </div>
                  )}
                  {key === "readiness" && t.enabled && (
                    <span className="text-xs text-zinc-500">
                      (optional Etsy processing profile ID — left blank, Etsy assigns one itself)
                    </span>
                  )}
                </div>
              );
            })}

            <p className={`text-xs ${totalCombinations > combinationsCap ? "font-medium text-red-600" : "text-zinc-500"}`}>
              {totalCombinations} combinations (max {combinationsCap}).
            </p>
            <p className="text-xs text-zinc-500">{disabledCount} rows disabled.</p>
            {violation && <p className="text-xs font-medium text-red-600">{violation}</p>}
          </div>

          {combos.length > 0 && !violation && (
            <VariationTable
              combos={combos}
              variations={variations}
              toggles={toggles}
              rows={value.variationRows}
              patchCell={patchCell}
              patchCells={patchCells}
              applyBulkFill={applyBulkFill}
              basePrice={value.price}
              baseQuantity={value.quantity}
              rowEnabled={value.variationRowEnabled}
              setRowsEnabled={setRowsEnabled}
            />
          )}
        </>
      )}

      {editor && (
        <VariationEditorModal
          mode={editor.mode}
          editingIndex={editor.mode === "edit" ? editor.index : null}
          variations={variations}
          hasCategory={value.taxonomyId != null}
          variationProperties={variationProperties}
          propertiesLoading={propertiesLoading}
          propertiesError={propertiesError}
          onCancel={() => setEditor(null)}
          onSave={(variation, index) => {
            const next = [...variations];
            if (index != null) next[index] = variation;
            else next.push(variation);
            patch({ variations: next });
            setEditor(null);
          }}
          onDelete={
            editor.mode === "edit"
              ? () => {
                  removeVariation(editor.index);
                  setEditor(null);
                }
              : undefined
          }
          onGoToDetails={
            onGoToTab
              ? () => {
                  onGoToTab("details");
                  setEditor(null);
                }
              : undefined
          }
        />
      )}
    </section>
  );
}

interface VariationDraft {
  source: "etsy" | "custom";
  /** Etsy source only. */
  propertyId: number | null;
  /** Etsy source only, when the property has scales (e.g. shoe sizing US/UK/EU). */
  scaleId: number | null;
  name: string;
  /** Stable per-option ids — see {@link ListingFormVariation.valueIds}. */
  valueIds: number[];
  values: string[];
  linksPhotos: boolean;
}
const EMPTY_VARIATION_DRAFT: VariationDraft = {
  source: "etsy",
  propertyId: null,
  scaleId: null,
  name: "",
  valueIds: [],
  values: [],
  linksPhotos: false,
};

type ModalStep =
  | { kind: "pickProperty" }
  | { kind: "pickValues"; property: TaxonomyProperty }
  | { kind: "custom" };

/**
 * Adds or edits exactly one variation: a property picker (add only — an
 * Etsy taxonomy property, or "Create your own") followed by the value
 * picker or the custom-variation editor. Editing an existing variation
 * skips straight to whichever of those two it already uses. Saving or
 * deleting closes the modal; the variation list, toggles, counters and grid
 * all live on the page and are untouched by this component.
 */
function VariationEditorModal({
  mode,
  editingIndex,
  variations,
  hasCategory,
  variationProperties,
  propertiesLoading,
  propertiesError,
  onCancel,
  onSave,
  onDelete,
  onGoToDetails,
}: {
  mode: "add" | "edit";
  /** Index into `variations` being edited, or `null` when adding. */
  editingIndex: number | null;
  /** The real, already-saved variation list — used to compute taken properties and the next custom-property id. */
  variations: ListingFormVariation[];
  /** Whether a category (taxonomy_id) has been chosen yet — without one, Etsy has no properties to offer. */
  hasCategory: boolean;
  variationProperties: TaxonomyProperty[];
  propertiesLoading: boolean;
  propertiesError: string | null;
  onCancel: () => void;
  onSave: (variation: ListingFormVariation, editingIndex: number | null) => void;
  /** Only set when editing — deletes the variation being edited and closes the modal. */
  onDelete?: () => void;
  /** Sends the user to the Details tab to pick a category, closing this modal. Omitted -> no link is shown. */
  onGoToDetails?: () => void;
}) {
  const editingVariation = editingIndex != null ? variations[editingIndex] : null;

  const [step, setStep] = useState<ModalStep>(() => {
    if (!editingVariation) return { kind: "pickProperty" };
    if (editingVariation.isCustom) return { kind: "custom" };
    const property = variationProperties.find((p) => p.propertyId === editingVariation.propertyId);
    // Falls back to the "Create your own" step if the property vanished (e.g. the category changed) —
    // the values already picked are preserved either way.
    return property ? { kind: "pickValues", property } : { kind: "custom" };
  });
  const [variationDraft, setVariationDraft] = useState<VariationDraft>(() =>
    editingVariation
      ? {
          source: editingVariation.isCustom ? "custom" : "etsy",
          propertyId: editingVariation.isCustom ? null : editingVariation.propertyId,
          scaleId: null,
          name: editingVariation.name,
          valueIds: editingVariation.valueIds,
          values: editingVariation.values,
          linksPhotos: editingVariation.linksPhotos,
        }
      : EMPTY_VARIATION_DRAFT,
  );

  function pickProperty(p: TaxonomyProperty) {
    setVariationDraft({
      source: "etsy",
      propertyId: p.propertyId,
      scaleId: p.scales[0]?.scaleId ?? null,
      name: p.displayName,
      valueIds: [],
      values: [],
      linksPhotos: false,
    });
    setStep({ kind: "pickValues", property: p });
  }
  function pickCustom() {
    setVariationDraft({ ...EMPTY_VARIATION_DRAFT, source: "custom" });
    setStep({ kind: "custom" });
  }

  function commit() {
    const variation: ListingFormVariation =
      variationDraft.source === "etsy"
        ? {
            propertyId: variationDraft.propertyId as number,
            name: variationDraft.name,
            isCustom: false,
            valueIds: variationDraft.valueIds,
            values: variationDraft.values,
            linksPhotos: variationDraft.linksPhotos,
          }
        : {
            propertyId: nextCustomPropertyId(variations, editingIndex),
            name: variationDraft.name.trim(),
            isCustom: true,
            // Stable ids assigned by CustomOptionsInput as options are added —
            // never recomputed from position, so a rename or reorder can't
            // scramble which combination row an option's data belongs to.
            valueIds: variationDraft.valueIds,
            values: variationDraft.values,
            linksPhotos: variationDraft.linksPhotos,
          };
    onSave(variation, editingIndex);
  }

  const usedPropertyIds = variations.filter((_, i) => i !== editingIndex).map((v) => v.propertyId);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-label={mode === "add" ? "Add variation" : "Edit variation"}
        className="flex max-h-[90vh] w-full max-w-lg flex-col rounded-xl border border-black/10 bg-white shadow-xl dark:border-white/15 dark:bg-zinc-950"
      >
        <div className="border-b border-black/10 px-4 py-3 dark:border-white/15">
          <h3 className="text-base font-bold text-zinc-900 dark:text-zinc-50">
            {mode === "add" ? "Add variation" : "Edit variation"}
          </h3>
        </div>

        <div className="flex-1 overflow-y-auto p-4">
          {/* ---- property picker (add only) ---- */}
          {step.kind === "pickProperty" && (
            <div className="space-y-3">
              <h4 className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">
                Add up to {MAX_VARIATIONS} variations for your item
              </h4>
              <ul className="list-disc space-y-1 pl-5 text-xs text-zinc-500">
                <li>Buyers can filter their search by Etsy&apos;s listed options.</li>
                <li>Custom options are not filterable.</li>
              </ul>

              {!hasCategory && (
                <p className="text-xs text-zinc-500">
                  Choose a category first — Etsy&apos;s variation options depend on it.{" "}
                  {onGoToDetails ? (
                    <button type="button" onClick={onGoToDetails} className="font-medium text-[#f56400] hover:underline">
                      Go to Details
                    </button>
                  ) : (
                    "Go to the Details tab."
                  )}
                </p>
              )}
              {hasCategory && propertiesLoading && (
                <p className="text-xs text-zinc-500">Loading category properties…</p>
              )}
              {hasCategory && propertiesError && <p className="text-xs text-red-600">{propertiesError}</p>}
              {hasCategory && !propertiesLoading && !propertiesError && variationProperties.length === 0 && (
                <p className="text-xs text-zinc-500">No Etsy variation properties for this category.</p>
              )}

              {variationProperties.filter((p) => !usedPropertyIds.includes(p.propertyId)).length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {variationProperties
                    .filter((p) => !usedPropertyIds.includes(p.propertyId))
                    .map((p) => (
                      <button
                        key={p.propertyId}
                        type="button"
                        onClick={() => pickProperty(p)}
                        className="rounded-full border border-black/10 px-3 py-1.5 text-sm hover:bg-black/[.04] dark:border-white/15 dark:hover:bg-white/[.06]"
                      >
                        {p.displayName}
                      </button>
                    ))}
                </div>
              )}

              <button
                type="button"
                onClick={pickCustom}
                className="block text-sm font-medium text-[#f56400] hover:underline"
              >
                + Create your own
              </button>

              <button
                type="button"
                onClick={onCancel}
                className="h-8 rounded-lg border border-black/10 px-3 text-xs hover:bg-black/[.04] dark:border-white/15 dark:hover:bg-white/[.06]"
              >
                Cancel
              </button>
            </div>
          )}

          {/* ---- values for a real Etsy property ---- */}
          {step.kind === "pickValues" && (
            <VariationValuePicker
              property={step.property}
              draft={variationDraft}
              setDraft={setVariationDraft}
              isEditing={editingIndex != null}
              onCancel={onCancel}
              onCommit={commit}
            />
          )}

          {/* ---- create your own ---- */}
          {step.kind === "custom" && (
            <div className="space-y-4">
              <h4 className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">Custom variation</h4>

              <label className="block text-sm">
                <span className="text-xs text-zinc-500">Name *</span>
                <input
                  type="text"
                  required
                  value={variationDraft.name}
                  onChange={(e) => setVariationDraft((d) => ({ ...d, name: e.target.value }))}
                  placeholder="e.g. Paper type"
                  className="mt-1 h-9 w-full rounded-lg border border-black/10 bg-white px-2 text-sm outline-none focus:border-[#f56400] dark:border-white/15 dark:bg-zinc-950"
                />
              </label>

              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={variationDraft.linksPhotos}
                  onChange={(e) => setVariationDraft((d) => ({ ...d, linksPhotos: e.target.checked }))}
                  className="accent-[#f56400]"
                />
                Link photos to this variation
              </label>

              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <h5 className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">Options</h5>
                  <span className="rounded-full bg-black/[.06] px-2 py-0.5 text-xs font-medium text-zinc-600 dark:bg-white/10 dark:text-zinc-300">
                    {variationDraft.values.length}
                  </span>
                </div>
                <p className="text-xs text-zinc-500">
                  Buyers choose from these options. Etsy&apos;s own options give your listing peak
                  discoverability — custom options are not filterable.
                </p>
                <CustomOptionsInput
                  options={variationDraft.values.map((text, i) => ({ id: variationDraft.valueIds[i], text }))}
                  onChange={(options) =>
                    setVariationDraft((d) => ({
                      ...d,
                      valueIds: options.map((o) => o.id),
                      values: options.map((o) => o.text),
                    }))
                  }
                />
              </div>

              <div className="flex justify-between pt-1">
                {onDelete ? (
                  <button
                    type="button"
                    onClick={onDelete}
                    className="h-8 rounded-lg border border-black/10 px-3 text-xs text-red-600 hover:bg-red-50 dark:border-white/15 dark:hover:bg-red-950/30"
                  >
                    Delete variation
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={onCancel}
                    className="h-8 rounded-lg border border-black/10 px-3 text-xs hover:bg-black/[.04] dark:border-white/15 dark:hover:bg-white/[.06]"
                  >
                    Cancel
                  </button>
                )}
                <button
                  type="button"
                  disabled={variationDraft.name.trim() === "" || variationDraft.values.length === 0}
                  onClick={commit}
                  className="h-8 rounded-lg bg-[#f56400] px-3 text-xs font-medium text-white disabled:cursor-not-allowed disabled:opacity-40"
                >
                  Done
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function VariationCard({
  variation,
  onEdit,
  onDelete,
}: {
  variation: ListingFormVariation;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="flex items-start justify-between gap-3 rounded-lg border border-black/10 p-3 dark:border-white/15">
      <div className="min-w-0">
        <p className="text-sm font-medium">
          {variation.name}{" "}
          <span className="font-normal text-zinc-500">
            · {variation.values.length} options
            {variation.isCustom ? " · custom variation" : ""}
          </span>
        </p>
        <div className="mt-1.5 flex flex-wrap gap-1">
          {variation.values.map((v, i) => (
            <span key={i} className="rounded-full bg-black/[.06] px-2 py-0.5 text-xs dark:bg-white/10">
              {v}
            </span>
          ))}
        </div>
      </div>
      <div className="flex shrink-0 gap-1">
        <button
          type="button"
          onClick={onEdit}
          aria-label={`Edit ${variation.name} variation`}
          className="rounded p-1.5 text-zinc-500 hover:bg-black/[.04] hover:text-zinc-800 dark:hover:bg-white/[.06] dark:hover:text-zinc-100"
        >
          ✎
        </button>
        <button
          type="button"
          onClick={onDelete}
          aria-label={`Delete ${variation.name} variation`}
          className="rounded p-1.5 text-zinc-500 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-950/30"
        >
          🗑
        </button>
      </div>
    </div>
  );
}

/**
 * STEP 3a: values for a real Etsy taxonomy property — a scale selector when
 * the property has more than one (e.g. US/UK/EU shoe sizing), Etsy's
 * predefined values as checkboxes (scoped to the chosen scale), and a
 * free-text row for values Etsy doesn't list. Free-text additions get a
 * synthetic negative id (unique, never collides with a real value id) so
 * they can live in the same `valueIds` array; the payload builder later
 * turns a negative id into `value_id: null` for Etsy.
 */
function VariationValuePicker({
  property,
  draft,
  setDraft,
  isEditing,
  onCancel,
  onCommit,
}: {
  property: TaxonomyProperty;
  draft: VariationDraft;
  setDraft: (updater: (d: VariationDraft) => VariationDraft) => void;
  isEditing: boolean;
  onCancel: () => void;
  onCommit: () => void;
}) {
  const [query, setQuery] = useState("");
  const [customDraft, setCustomDraft] = useState("");

  const scaleId = draft.scaleId ?? property.scales[0]?.scaleId ?? null;
  const candidates =
    property.scales.length > 0 ? property.possibleValues.filter((v) => v.scaleId === scaleId) : property.possibleValues;

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = q ? candidates.filter((v) => v.name.toLowerCase().includes(q)) : candidates;
    return filtered.slice(0, MAX_PROPERTY_ROWS);
  }, [candidates, query]);

  function toggleValue(pv: { valueId: number | null; name: string }) {
    if (pv.valueId == null) return;
    setDraft((d) => {
      const idx = d.valueIds.indexOf(pv.valueId as number);
      if (idx >= 0) {
        return { ...d, valueIds: d.valueIds.filter((_, i) => i !== idx), values: d.values.filter((_, i) => i !== idx) };
      }
      return { ...d, valueIds: [...d.valueIds, pv.valueId as number], values: [...d.values, pv.name] };
    });
  }

  function addCustomValue() {
    const name = customDraft.trim();
    if (!name) return;
    setDraft((d) => {
      if (d.values.some((v) => v.toLowerCase() === name.toLowerCase())) return d;
      const nextId = Math.min(0, ...d.valueIds) - 1; // synthetic, negative — never collides with a real (positive) value id
      return { ...d, valueIds: [...d.valueIds, nextId], values: [...d.values, name] };
    });
    setCustomDraft("");
  }
  function removeValue(i: number) {
    setDraft((d) => ({ ...d, valueIds: d.valueIds.filter((_, idx) => idx !== i), values: d.values.filter((_, idx) => idx !== i) }));
  }

  const canCommit = draft.valueIds.length > 0;

  return (
    <div className="space-y-3">
      <h4 className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">{property.displayName}</h4>

      {property.scales.length > 0 && (
        <label className="block text-sm">
          <span className="text-xs text-zinc-500">Scale</span>
          <select
            value={scaleId ?? ""}
            onChange={(e) => setDraft((d) => ({ ...d, scaleId: Number(e.target.value), valueIds: [], values: [] }))}
            className="mt-1 h-9 w-full rounded-lg border border-black/10 bg-white px-2 text-sm outline-none focus:border-[#f56400] dark:border-white/15 dark:bg-zinc-950"
          >
            {property.scales.map((s) => (
              <option key={s.scaleId} value={s.scaleId}>
                {s.displayName}
              </option>
            ))}
          </select>
        </label>
      )}

      <div className="overflow-hidden rounded-lg border border-black/10 dark:border-white/15">
        <div className="border-b border-black/10 p-1.5 dark:border-white/15">
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search…"
            className="h-7 w-full rounded-md bg-transparent px-1.5 text-xs outline-none"
          />
        </div>
        <div className="h-40 overflow-y-auto p-1">
          {rows.length === 0 && <p className="px-2 py-3 text-center text-xs text-zinc-400">No results.</p>}
          {rows.map((pv) => {
            const checked = pv.valueId != null && draft.valueIds.includes(pv.valueId);
            return (
              <label
                key={pv.valueId ?? pv.name}
                className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-xs hover:bg-black/[.04] dark:hover:bg-white/[.06]"
              >
                <input type="checkbox" checked={checked} onChange={() => toggleValue(pv)} className="accent-[#f56400]" />
                {pv.name}
              </label>
            );
          })}
        </div>
      </div>

      <div>
        <span className="text-xs text-zinc-500">Add a custom value (not filterable by buyers)</span>
        <div className="mt-1 flex flex-wrap items-center gap-1.5 rounded-lg border border-black/10 p-1.5 dark:border-white/15">
          {draft.values.map((v, i) =>
            draft.valueIds[i] < 0 ? (
              <span key={i} className="flex items-center gap-1 rounded-full bg-black/[.06] px-2 py-0.5 text-xs dark:bg-white/10">
                {v}
                <button
                  type="button"
                  onClick={() => removeValue(i)}
                  aria-label={`Remove ${v}`}
                  className="text-zinc-500 hover:text-red-600"
                >
                  ×
                </button>
              </span>
            ) : null,
          )}
          <input
            type="text"
            value={customDraft}
            onChange={(e) => setCustomDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === ",") {
                e.preventDefault();
                addCustomValue();
              }
            }}
            onBlur={addCustomValue}
            placeholder="Type a value, press Enter…"
            className="min-w-[100px] flex-1 border-none bg-transparent px-1 py-0.5 text-sm outline-none"
          />
        </div>
      </div>

      <p className="truncate text-xs text-zinc-600 dark:text-zinc-400">
        <span className="font-medium">Selected:</span> {draft.values.length ? draft.values.join(", ") : "—"}
      </p>

      <div className="flex gap-2">
        <button
          type="button"
          disabled={!canCommit}
          onClick={onCommit}
          className="h-8 rounded-lg bg-[#f56400] px-3 text-xs font-medium text-white disabled:cursor-not-allowed disabled:opacity-40"
        >
          {isEditing ? "Save" : "Add variation"}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="h-8 rounded-lg border border-black/10 px-3 text-xs hover:bg-black/[.04] dark:border-white/15 dark:hover:bg-white/[.06]"
        >
          Cancel
        </button>
      </div>
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
          className="h-9 flex-1 rounded-lg border border-black/10 bg-white px-2 text-sm outline-none focus:border-[#f56400] dark:border-white/15 dark:bg-zinc-950"
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
                className="h-7 flex-1 rounded border border-black/10 bg-white px-1.5 text-sm outline-none focus:border-[#f56400] dark:border-white/15 dark:bg-zinc-900"
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

/** The combination table — only rendered after "Apply", columns limited to the enabled toggles. */
function VariationTable({
  combos,
  variations,
  toggles,
  rows,
  patchCell,
  patchCells,
  applyBulkFill,
  basePrice,
  baseQuantity,
  rowEnabled,
  setRowsEnabled,
}: {
  combos: VariationCombo[];
  variations: ListingFormVariation[];
  toggles: Record<VariationToggleKey, VariationToggleState>;
  rows: Record<VariationToggleKey, Record<string, string>>;
  patchCell: (key: VariationToggleKey, cellKey: string, value: string) => void;
  patchCells: (key: VariationToggleKey, updates: Record<string, string>) => void;
  applyBulkFill: (key: VariationToggleKey, value: string) => void;
  basePrice: string;
  baseQuantity: string;
  /** Per full combination — `false` means disabled. Absent/true means enabled. */
  rowEnabled: Record<string, boolean>;
  setRowsEnabled: (keys: string[], enabled: boolean) => void;
}) {
  const activeCols = (["price", "readiness", "quantity", "sku"] as VariationToggleKey[]).filter(
    (k) => toggles[k].enabled,
  );
  const [bulk, setBulk] = useState<Record<VariationToggleKey, string>>({
    price: "",
    readiness: "",
    quantity: "",
    sku: "",
  });
  const firstVariation = variations[0];
  const secondVariation = variations[1];
  const [disableValueId, setDisableValueId] = useState("");

  // ---- row selection, for bulk price edits below ----
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [selectValueId0, setSelectValueId0] = useState("");
  const [selectValueId1, setSelectValueId1] = useState("");
  const [setPriceDraft, setSetPriceDraft] = useState("");
  const [adjustDraft, setAdjustDraft] = useState("");
  const [adjustError, setAdjustError] = useState<string | null>(null);
  const selectAllRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (selectAllRef.current) {
      selectAllRef.current.indeterminate = selected.size > 0 && selected.size < combos.length;
    }
  }, [selected, combos.length]);

  // Selection is keyed by combos that still exist — a variation edit that
  // removes/renames options should never leave stale keys selected. Pruning
  // derived state to match a prop change, not a DOM/external-system sync.
  useEffect(() => {
    const validKeys = new Set(combos.map(fullComboKey));
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSelected((prev) => {
      const next = new Set([...prev].filter((k) => validKeys.has(k)));
      return next.size === prev.size ? prev : next;
    });
  }, [combos]);

  function toggleRow(rowKey: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(rowKey)) next.delete(rowKey);
      else next.add(rowKey);
      return next;
    });
  }
  function toggleSelectAll() {
    setSelected((prev) => (prev.size === combos.length ? new Set() : new Set(combos.map(fullComboKey))));
  }
  /** Replaces the selection with exactly the rows where variation `index` has `valueId` — one click selects a whole size or colour. */
  function selectWhereVariationIs(index: number, valueId: number) {
    setSelected(new Set(combos.filter((c) => c.valueIds[index] === valueId).map(fullComboKey)));
  }

  /** The distinct price cell keys touched by the currently-selected rows (a price scoped to fewer variations than shown can be shared by several rows). */
  function selectedPriceCellKeys(): string[] {
    const keys = new Set<string>();
    for (const c of combos) {
      if (selected.has(fullComboKey(c))) keys.add(comboKeyFor(toggles.price.appliesTo, c));
    }
    return [...keys];
  }

  function applySetPriceToSelected() {
    const parsedPrice = Number.parseFloat(setPriceDraft);
    if (!Number.isFinite(parsedPrice) || parsedPrice <= 0) return;
    const formatted = parsedPrice.toFixed(2);
    const updates: Record<string, string> = {};
    for (const cellKey of selectedPriceCellKeys()) updates[cellKey] = formatted;
    patchCells("price", updates);
    setSetPriceDraft("");
  }

  function applyAdjustmentToSelected() {
    const parsed = parsePriceAdjustment(adjustDraft);
    if (!parsed) {
      setAdjustError('Enter a fixed amount (e.g. "2.00" or "-2.00") or a percentage (e.g. "10%" or "-10%").');
      return;
    }
    setAdjustError(null);
    const updates: Record<string, string> = {};
    for (const cellKey of selectedPriceCellKeys()) {
      const current = Number.parseFloat(rows.price[cellKey] || basePrice) || 0;
      updates[cellKey] = applyPriceAdjustment(current, parsed).toFixed(2);
    }
    patchCells("price", updates);
    setAdjustDraft("");
  }

  return (
    <div className="mt-3">
      {/* ---- bulk visibility actions ---- */}
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => setRowsEnabled(combos.map(fullComboKey), true)}
          className="h-8 rounded-lg border border-black/10 px-2 text-xs hover:bg-black/[.04] dark:border-white/15 dark:hover:bg-white/[.06]"
        >
          Enable all
        </button>
        <button
          type="button"
          onClick={() => setRowsEnabled(combos.map(fullComboKey), false)}
          className="h-8 rounded-lg border border-black/10 px-2 text-xs hover:bg-black/[.04] dark:border-white/15 dark:hover:bg-white/[.06]"
        >
          Disable all
        </button>
        {firstVariation && (
          <div className="flex items-center gap-1.5">
            <span className="text-xs text-zinc-500">Disable rows where {firstVariation.name} is</span>
            <select
              value={disableValueId}
              onChange={(e) => setDisableValueId(e.target.value)}
              className="h-8 rounded-md border border-black/10 bg-white px-1.5 text-xs outline-none dark:border-white/15 dark:bg-zinc-900"
            >
              <option value="">Select…</option>
              {firstVariation.valueIds.map((id, i) => (
                <option key={id} value={id}>
                  {firstVariation.values[i]}
                </option>
              ))}
            </select>
            <button
              type="button"
              disabled={!disableValueId}
              onClick={() => {
                const id = Number(disableValueId);
                const keys = combos.filter((c) => c.valueIds[0] === id).map(fullComboKey);
                setRowsEnabled(keys, false);
              }}
              className="h-8 rounded-lg border border-black/10 px-2 text-xs hover:bg-black/[.04] disabled:cursor-not-allowed disabled:opacity-40 dark:border-white/15 dark:hover:bg-white/[.06]"
            >
              Disable
            </button>
          </div>
        )}
      </div>

      {/* ---- bulk selection actions ---- */}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {firstVariation && (
          <div className="flex items-center gap-1.5">
            <span className="text-xs text-zinc-500">Select rows where {firstVariation.name} is</span>
            <select
              value={selectValueId0}
              onChange={(e) => setSelectValueId0(e.target.value)}
              className="h-8 rounded-md border border-black/10 bg-white px-1.5 text-xs outline-none dark:border-white/15 dark:bg-zinc-900"
            >
              <option value="">Select…</option>
              {firstVariation.valueIds.map((id, i) => (
                <option key={id} value={id}>
                  {firstVariation.values[i]}
                </option>
              ))}
            </select>
            <button
              type="button"
              disabled={!selectValueId0}
              onClick={() => selectWhereVariationIs(0, Number(selectValueId0))}
              className="h-8 rounded-lg border border-black/10 px-2 text-xs hover:bg-black/[.04] disabled:cursor-not-allowed disabled:opacity-40 dark:border-white/15 dark:hover:bg-white/[.06]"
            >
              Select
            </button>
          </div>
        )}
        {secondVariation && (
          <div className="flex items-center gap-1.5">
            <span className="text-xs text-zinc-500">Select rows where {secondVariation.name} is</span>
            <select
              value={selectValueId1}
              onChange={(e) => setSelectValueId1(e.target.value)}
              className="h-8 rounded-md border border-black/10 bg-white px-1.5 text-xs outline-none dark:border-white/15 dark:bg-zinc-900"
            >
              <option value="">Select…</option>
              {secondVariation.valueIds.map((id, i) => (
                <option key={id} value={id}>
                  {secondVariation.values[i]}
                </option>
              ))}
            </select>
            <button
              type="button"
              disabled={!selectValueId1}
              onClick={() => selectWhereVariationIs(1, Number(selectValueId1))}
              className="h-8 rounded-lg border border-black/10 px-2 text-xs hover:bg-black/[.04] disabled:cursor-not-allowed disabled:opacity-40 dark:border-white/15 dark:hover:bg-white/[.06]"
            >
              Select
            </button>
          </div>
        )}
        <span className="text-xs text-zinc-500">
          {selected.size} of {combos.length} selected
        </span>
        {selected.size > 0 && (
          <button
            type="button"
            onClick={() => setSelected(new Set())}
            className="text-xs font-medium text-zinc-500 hover:underline"
          >
            Clear selection
          </button>
        )}
      </div>

      {/* ---- bulk price edit for the selected rows ---- */}
      {activeCols.includes("price") && selected.size > 0 && (
        <div className="mt-2 flex flex-wrap items-center gap-4 rounded-lg border border-black/10 p-2 dark:border-white/15">
          <div className="flex items-center gap-1">
            <input
              type="number"
              min="0"
              step="0.01"
              value={setPriceDraft}
              onChange={(e) => setSetPriceDraft(e.target.value)}
              placeholder="Set price"
              className="h-8 w-28 rounded-lg border border-black/10 bg-white px-2 text-xs outline-none focus:border-[#f56400] dark:border-white/15 dark:bg-zinc-950"
            />
            <button
              type="button"
              disabled={!setPriceDraft}
              onClick={applySetPriceToSelected}
              className="h-8 rounded-lg border border-black/10 px-2 text-xs hover:bg-black/[.04] disabled:cursor-not-allowed disabled:opacity-40 dark:border-white/15 dark:hover:bg-white/[.06]"
            >
              Apply to selected
            </button>
          </div>
          <div className="flex items-center gap-1">
            <input
              type="text"
              value={adjustDraft}
              onChange={(e) => {
                setAdjustDraft(e.target.value);
                setAdjustError(null);
              }}
              placeholder="e.g. +2.00 or -10%"
              className="h-8 w-32 rounded-lg border border-black/10 bg-white px-2 text-xs outline-none focus:border-[#f56400] dark:border-white/15 dark:bg-zinc-950"
            />
            <button
              type="button"
              disabled={!adjustDraft}
              onClick={applyAdjustmentToSelected}
              className="h-8 rounded-lg border border-black/10 px-2 text-xs hover:bg-black/[.04] disabled:cursor-not-allowed disabled:opacity-40 dark:border-white/15 dark:hover:bg-white/[.06]"
            >
              Adjust selected
            </button>
          </div>
          {adjustError && <p className="w-full text-xs font-medium text-red-600">{adjustError}</p>}
        </div>
      )}

      {activeCols.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-2">
          {activeCols.map((k) => (
            <div key={k} className="flex items-center gap-1">
              <input
                type="text"
                value={bulk[k]}
                onChange={(e) => setBulk((b) => ({ ...b, [k]: e.target.value }))}
                placeholder={`Fill all ${VARIATION_COLUMN_LABEL[k]} fields`}
                className="h-8 w-44 rounded-lg border border-black/10 bg-white px-2 text-xs outline-none focus:border-[#f56400] dark:border-white/15 dark:bg-zinc-950"
              />
              <button
                type="button"
                onClick={() => applyBulkFill(k, bulk[k])}
                className="h-8 rounded-lg border border-black/10 px-2 text-xs hover:bg-black/[.04] dark:border-white/15 dark:hover:bg-white/[.06]"
              >
                Apply to all
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="mt-2 max-h-80 overflow-auto rounded-lg border border-black/10 dark:border-white/15">
        <table className="w-full text-xs">
          <thead className="sticky top-0 bg-zinc-50 dark:bg-zinc-900">
            <tr>
              <th className="px-2 py-1.5 text-left font-medium text-zinc-500">
                <input
                  ref={selectAllRef}
                  type="checkbox"
                  checked={combos.length > 0 && selected.size === combos.length}
                  onChange={toggleSelectAll}
                  aria-label="Select all rows"
                  className="accent-[#f56400]"
                />
              </th>
              <th className="px-2 py-1.5 text-left font-medium text-zinc-500">
                <span className="sr-only">Enabled</span>
              </th>
              {variations.map((v) => (
                <th key={v.propertyId} className="px-2 py-1.5 text-left font-medium text-zinc-500">
                  {v.name}
                </th>
              ))}
              {activeCols.map((k) => (
                <th key={k} className="px-2 py-1.5 text-left font-medium text-zinc-500">
                  {VARIATION_COLUMN_LABEL[k]}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {combos.map((c) => {
              const rowKey = fullComboKey(c);
              const enabled = rowEnabled[rowKey] !== false;
              const isSelected = selected.has(rowKey);
              return (
                <tr
                  key={rowKey}
                  className={`border-t border-black/5 dark:border-white/10 ${enabled ? "" : "opacity-40"} ${
                    isSelected ? "bg-[#f56400]/5" : ""
                  }`}
                >
                  <td className="px-2 py-1">
                    <input
                      type="checkbox"
                      checked={isSelected}
                      onChange={() => toggleRow(rowKey)}
                      aria-label={`Select ${c.values.join(" / ")}`}
                      className="accent-[#f56400]"
                    />
                  </td>
                  <td className="px-2 py-1">
                    <button
                      type="button"
                      onClick={() => setRowsEnabled([rowKey], !enabled)}
                      aria-label={enabled ? "Disable this combination" : "Enable this combination"}
                      title={enabled ? "Sold — click to disable" : "Not sold — click to enable"}
                      className="text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200"
                    >
                      {enabled ? "👁" : "⊘"}
                    </button>
                  </td>
                  {c.values.map((v, i) => (
                    <td key={i} className="px-2 py-1">
                      {v}
                    </td>
                  ))}
                  {activeCols.map((k) => {
                    const cellKey = comboKeyFor(toggles[k].appliesTo, c);
                    return (
                      <td key={k} className="px-2 py-1">
                        <input
                          type={k === "sku" ? "text" : "number"}
                          min={k === "sku" ? undefined : "0"}
                          step={k === "price" ? "0.01" : k === "sku" ? undefined : "1"}
                          value={rows[k][cellKey] ?? ""}
                          onChange={(e) => patchCell(k, cellKey, e.target.value)}
                          placeholder={
                            k === "price"
                              ? basePrice || "0.00"
                              : k === "quantity"
                                ? baseQuantity || "1"
                                : k === "readiness"
                                  ? "optional"
                                  : ""
                          }
                          className="h-7 w-24 rounded-md border border-black/10 bg-white px-1.5 outline-none focus:border-[#f56400] dark:border-white/15 dark:bg-zinc-950"
                        />
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
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
  "mt-1 h-9 w-full rounded-lg border border-black/10 bg-white px-2 text-sm outline-none focus:border-[#f56400] dark:border-white/15 dark:bg-zinc-950";

function PersonalizationSection({
  value,
  patch,
  sectionHeadingCls,
}: {
  value: ListingFormValue;
  patch: (partial: Partial<ListingFormValue>) => void;
  sectionHeadingCls: string;
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
    <section className="max-w-2xl space-y-6">
      <h3 className={sectionHeadingCls}>Personalization</h3>
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
    </section>
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
          className="accent-[#f56400]"
        />
        Required
      </label>

      {error && <p className="text-xs font-medium text-red-600">{error}</p>}
    </div>
  );
}
