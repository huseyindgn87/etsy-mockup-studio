"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  MAX_OPTIONS_PER_VARIATION,
  MAX_PRICED_ROWS,
  MAX_VARIATION_COMBINATIONS,
} from "@/lib/etsy/variation-limits";

/** The shape this form edits — read by the page when publishing `mode: "new"`. */
export interface ListingFormProperty {
  name: string;
  valueIds: number[];
  values: string[];
  scaleId?: number | null;
}

/** Etsy's two reserved "Custom Variation" property slots — no taxonomy entry, user-named. */
const CUSTOM_PROPERTY_IDS = [513, 514] as const;

/** One variation dimension (colour, size, or a user-typed custom one). */
export interface ListingFormVariation {
  /** A real taxonomy property id, or 513/514 for a custom ("Custom") variation. */
  propertyId: number;
  name: string;
  isCustom: boolean;
  valueIds: number[];
  values: string[];
}

export type VariationToggleKey = "price" | "readiness" | "quantity" | "sku";

/** One tab of the left-nav listing editor that this form's fields live in. */
export type ListingFormTab =
  | "title"
  | "description"
  | "tags"
  | "details"
  | "price"
  | "inventory"
  | "variations"
  | "shipping";

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
  /** Up to 2, in display order (first/second). */
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
  variations: [],
  variationToggles: EMPTY_VARIATION_TOGGLES,
  variationRows: EMPTY_VARIATION_ROWS,
  variationRowEnabled: {},
};

const MAX_TAGS = 13;
const MAX_TAG_LENGTH = 20;
const MAX_TITLE_LENGTH = 140;
/** Etsy itself caps a listing at 2 variations. */
const MAX_VARIATIONS = 2;

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
  possibleValues: { valueId: number | null; name: string }[];
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
}: {
  value: ListingFormValue;
  onChange: (next: ListingFormValue) => void;
  activeTab: ListingFormTab | null;
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

  useEffect(() => {
    if (!value.taxonomyId) {
      // Category cleared — reset synchronously, matching the empty-query
      // reset elsewhere in this app's pickers.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setProperties([]);
      return;
    }
    const controller = new AbortController();
    setPropertiesLoading(true);
    fetch(`/api/etsy/taxonomy/${value.taxonomyId}/properties`, { signal: controller.signal })
      .then((res) => (res.ok ? res.json() : null))
      .then((body: { properties?: TaxonomyProperty[] } | null) => {
        setProperties(body?.properties ?? []);
      })
      .catch(() => {
        if (!controller.signal.aborted) setProperties([]);
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

  const inputCls =
    "w-full rounded-lg border border-black/10 bg-white px-3 text-sm outline-none focus:border-[#f56400] dark:border-white/15 dark:bg-zinc-950";
  const sectionHeadingCls = "text-base font-bold text-zinc-900 dark:text-zinc-50";

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

          <label className="block text-sm">
            <span className="text-xs text-zinc-500">Section</span>
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
          </label>
        </section>
      )}

      {activeTab === "price" && (
        <section className="max-w-xs space-y-3">
          <h3 className={sectionHeadingCls}>Price</h3>
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
          value={value}
          patch={patch}
          sectionHeadingCls={sectionHeadingCls}
        />
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
 * checking one clears any other selection for that property. Also reused
 * (always in multi-select form) by the Variations editor below.
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
// Variations — modelled on Etsy's own "Manage variations" screen, but on one
// screen (no stacked modals): a card list (name, option chips, edit/delete),
// an inline add/edit panel (Etsy property vs. hand-typed custom), four
// on/off fields ("varies by" first/second/both), a live combination count,
// and — on "Apply" — a table with only the enabled columns, bulk-fillable.
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

/** 513 for the first custom variation added, 514 for the second. */
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

function VariationsSection({
  variationProperties,
  value,
  patch,
  sectionHeadingCls,
}: {
  variationProperties: TaxonomyProperty[];
  value: ListingFormValue;
  patch: (partial: Partial<ListingFormValue>) => void;
  sectionHeadingCls: string;
}) {
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [draft, setDraft] = useState<VariationDraft>(EMPTY_DRAFT);
  const [applied, setApplied] = useState(false);

  function openAdd() {
    setEditingIndex(null);
    setDraft(EMPTY_DRAFT);
    setEditorOpen(true);
  }
  function openEdit(i: number) {
    const v = value.variations[i];
    setEditingIndex(i);
    setDraft({
      source: v.isCustom ? "custom" : "etsy",
      propertyId: v.isCustom ? null : v.propertyId,
      name: v.name,
      valueIds: v.valueIds,
      values: v.values,
    });
    setEditorOpen(true);
  }
  function closeEditor() {
    setEditorOpen(false);
    setEditingIndex(null);
  }

  function commitEditor() {
    const variation: ListingFormVariation =
      draft.source === "etsy"
        ? {
            propertyId: draft.propertyId as number,
            name: draft.name,
            isCustom: false,
            valueIds: draft.valueIds,
            values: draft.values,
          }
        : {
            propertyId: nextCustomPropertyId(value.variations, editingIndex),
            name: draft.name.trim(),
            isCustom: true,
            valueIds: draft.values.map((_, i) => i + 1),
            values: draft.values,
          };
    const nextVariations = [...value.variations];
    if (editingIndex != null) nextVariations[editingIndex] = variation;
    else nextVariations.push(variation);
    patch({ variations: nextVariations });
    setApplied(false);
    closeEditor();
  }

  function removeVariation(i: number) {
    const nextVariations = value.variations.filter((_, idx) => idx !== i);
    const nextToggles = { ...value.variationToggles };
    for (const key of Object.keys(nextToggles) as VariationToggleKey[]) {
      const t = nextToggles[key];
      const appliesTo = reindexAppliesTo(t.appliesTo, i);
      nextToggles[key] = { enabled: t.enabled && appliesTo.length > 0, appliesTo };
    }
    patch({ variations: nextVariations, variationToggles: nextToggles });
    if (editingIndex === i) closeEditor();
    setApplied(false);
  }

  // Analytical counts — cheap even when the real combinations count is too
  // large to materialize, so the limit checks below never need the full grid.
  const oversizedVariation = value.variations.find((v) => v.values.length > MAX_OPTIONS_PER_VARIATION) ?? null;
  const totalCombinations =
    value.variations.length === 0
      ? 0
      : value.variations.reduce((acc, v) => acc * Math.max(v.valueIds.length, 1), 1);
  const distinctCountFor = (appliesTo: number[]): number =>
    appliesTo.reduce((acc, i) => acc * Math.max(value.variations[i]?.valueIds.length ?? 1, 1), 1);
  const pricedRows = Math.max(
    1,
    ...(["price", "quantity", "sku"] as const)
      .filter((k) => value.variationToggles[k].enabled)
      .map((k) => distinctCountFor(value.variationToggles[k].appliesTo)),
  );

  const violation: string | null = oversizedVariation
    ? `"${oversizedVariation.name}" has ${oversizedVariation.values.length} options — Etsy allows at most ${MAX_OPTIONS_PER_VARIATION} per variation type.`
    : totalCombinations > MAX_VARIATION_COMBINATIONS
      ? `${totalCombinations} combinations exceeds Etsy's limit of ${MAX_VARIATION_COMBINATIONS} per listing.`
      : pricedRows > MAX_PRICED_ROWS
        ? `${pricedRows} priced rows exceeds Etsy's limit of ${MAX_PRICED_ROWS} unique price/SKU/quantity values.`
        : null;

  const combos = useMemo<VariationCombo[]>(() => {
    if (value.variations.length === 0 || violation) return [];
    let acc: VariationCombo[] = [{ valueIds: [], values: [] }];
    for (const v of value.variations) {
      const next: VariationCombo[] = [];
      for (const a of acc) {
        for (let i = 0; i < v.valueIds.length; i++) {
          next.push({ valueIds: [...a.valueIds, v.valueIds[i]], values: [...a.values, v.values[i]] });
        }
      }
      acc = next;
    }
    return acc;
  }, [value.variations, violation]);

  function setToggle(key: VariationToggleKey, partial: Partial<VariationToggleState>) {
    patch({
      variationToggles: { ...value.variationToggles, [key]: { ...value.variationToggles[key], ...partial } },
    });
  }
  function patchCell(key: VariationToggleKey, cellKey: string, val: string) {
    patch({
      variationRows: { ...value.variationRows, [key]: { ...value.variationRows[key], [cellKey]: val } },
    });
  }
  function applyBulkFill(key: VariationToggleKey, val: string) {
    if (!val.trim()) return;
    const keys = new Set(combos.map((c) => comboKeyFor(value.variationToggles[key].appliesTo, c)));
    const nextCol = { ...value.variationRows[key] };
    for (const k of keys) nextCol[k] = val;
    patch({ variationRows: { ...value.variationRows, [key]: nextCol } });
  }

  const disabledCount = combos.filter((c) => value.variationRowEnabled[fullComboKey(c)] === false).length;

  function setRowsEnabled(keys: string[], enabled: boolean) {
    const next = { ...value.variationRowEnabled };
    for (const k of keys) {
      if (enabled) delete next[k];
      else next[k] = false;
    }
    patch({ variationRowEnabled: next });
  }

  const usedPropertyIds = value.variations.filter((_, i) => i !== editingIndex).map((v) => v.propertyId);

  return (
    <section className="space-y-3">
      <h3 className={sectionHeadingCls}>Variations</h3>

      {!editorOpen && value.variations.length < MAX_VARIATIONS && (
        <button
          type="button"
          onClick={openAdd}
          className="h-9 rounded-lg border border-dashed border-black/20 px-3 text-sm text-zinc-600 hover:bg-black/[.04] dark:border-white/25 dark:text-zinc-300 dark:hover:bg-white/[.06]"
        >
          Manage variations
        </button>
      )}

      {value.variations.length > 0 && (
        <div className="space-y-2">
          {value.variations.map((v, i) => (
            <VariationCard key={i} variation={v} onEdit={() => openEdit(i)} onDelete={() => removeVariation(i)} />
          ))}
        </div>
      )}

      {editorOpen && (
        <VariationEditorPanel
          draft={draft}
          setDraft={setDraft}
          isEditing={editingIndex != null}
          variationProperties={variationProperties.filter((p) => !usedPropertyIds.includes(p.propertyId))}
          onCancel={closeEditor}
          onCommit={commitEditor}
        />
      )}

      {value.variations.length > 0 && (
        <div className="mt-4 space-y-2 rounded-lg border border-black/10 p-3 dark:border-white/15">
          {VARIATION_TOGGLES.map(({ key, label }) => {
            const t = value.variationToggles[key];
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
                          enabled && t.appliesTo.length === 0
                            ? value.variations.map((_, i) => i)
                            : t.appliesTo,
                      });
                    }}
                    className="accent-[#f56400]"
                  />
                  {label}
                </label>
                {t.enabled && value.variations.length > 1 && (
                  <select
                    value={t.appliesTo.length === 2 ? "both" : String(t.appliesTo[0] ?? 0)}
                    onChange={(e) => {
                      const v = e.target.value;
                      setToggle(key, { appliesTo: v === "both" ? [0, 1] : [Number(v)] });
                    }}
                    className="h-7 rounded-md border border-black/10 bg-white px-1.5 text-xs outline-none dark:border-white/15 dark:bg-zinc-900"
                  >
                    <option value="0">{value.variations[0].name}</option>
                    <option value="1">{value.variations[1].name}</option>
                    <option value="both">
                      {value.variations[0].name} and {value.variations[1].name}
                    </option>
                  </select>
                )}
                {key === "readiness" && t.enabled && (
                  <span className="text-xs text-zinc-500">
                    (optional Etsy processing profile ID — left blank, Etsy assigns one itself)
                  </span>
                )}
              </div>
            );
          })}

          <p className={`text-xs ${totalCombinations > MAX_VARIATION_COMBINATIONS ? "font-medium text-red-600" : "text-zinc-500"}`}>
            {totalCombinations} combinations (max {MAX_VARIATION_COMBINATIONS}).
          </p>
          <p className={`text-xs ${pricedRows > MAX_PRICED_ROWS ? "font-medium text-red-600" : "text-zinc-500"}`}>
            {pricedRows} priced rows (max {MAX_PRICED_ROWS}).
          </p>
          <p className="text-xs text-zinc-500">{disabledCount} rows disabled.</p>
          {violation && <p className="text-xs font-medium text-red-600">{violation}</p>}

          <button
            type="button"
            onClick={() => setApplied(true)}
            disabled={!!violation}
            className="h-8 rounded-lg bg-[#f56400] px-3 text-xs font-medium text-white hover:bg-[#d95700] disabled:cursor-not-allowed disabled:opacity-40"
          >
            Apply
          </button>
        </div>
      )}

      {applied && combos.length > 0 && (
        <VariationTable
          combos={combos}
          variations={value.variations}
          toggles={value.variationToggles}
          rows={value.variationRows}
          patchCell={patchCell}
          applyBulkFill={applyBulkFill}
          basePrice={value.price}
          baseQuantity={value.quantity}
          rowEnabled={value.variationRowEnabled}
          setRowsEnabled={setRowsEnabled}
        />
      )}
    </section>
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

interface VariationDraft {
  source: "etsy" | "custom";
  /** Etsy source only. */
  propertyId: number | null;
  name: string;
  valueIds: number[];
  values: string[];
}
const EMPTY_DRAFT: VariationDraft = { source: "etsy", propertyId: null, name: "", valueIds: [], values: [] };

/** Inline (not a modal) add/edit panel — Etsy source picks values from {@link PropertyPicker}; custom is hand-typed. */
function VariationEditorPanel({
  draft,
  setDraft,
  isEditing,
  variationProperties,
  onCancel,
  onCommit,
}: {
  draft: VariationDraft;
  setDraft: (updater: (d: VariationDraft) => VariationDraft) => void;
  isEditing: boolean;
  variationProperties: TaxonomyProperty[];
  onCancel: () => void;
  onCommit: () => void;
}) {
  const selectedProp = variationProperties.find((p) => p.propertyId === draft.propertyId) ?? null;
  const canCommit =
    draft.source === "etsy"
      ? draft.propertyId != null && draft.valueIds.length > 0
      : draft.name.trim() !== "" && draft.values.length > 0;

  function toggleDraftValue(pv: { valueId: number | null; name: string }) {
    if (pv.valueId == null || !selectedProp) return;
    const nextIdSet = new Set(draft.valueIds);
    if (nextIdSet.has(pv.valueId)) nextIdSet.delete(pv.valueId);
    else nextIdSet.add(pv.valueId);
    const nextIds: number[] = [];
    const nextValues: string[] = [];
    for (const cand of selectedProp.possibleValues) {
      if (cand.valueId != null && nextIdSet.has(cand.valueId)) {
        nextIds.push(cand.valueId);
        nextValues.push(cand.name);
      }
    }
    setDraft((d) => ({ ...d, valueIds: nextIds, values: nextValues }));
  }

  const tabCls = (active: boolean) =>
    `rounded-full px-3 py-1 text-xs ${
      active
        ? "bg-[#f56400] text-white"
        : "border border-black/10 hover:bg-black/[.04] dark:border-white/15 dark:hover:bg-white/[.06]"
    }`;

  return (
    <div className="mt-2 rounded-lg border border-dashed border-black/20 p-3 dark:border-white/25">
      <div className="flex gap-1.5">
        <button type="button" onClick={() => setDraft(() => ({ ...EMPTY_DRAFT, source: "etsy" }))} className={tabCls(draft.source === "etsy")}>
          Default
        </button>
        <button type="button" onClick={() => setDraft(() => ({ ...EMPTY_DRAFT, source: "custom" }))} className={tabCls(draft.source === "custom")}>
          Custom
        </button>
      </div>

      {draft.source === "etsy" ? (
        <div className="mt-3">
          {variationProperties.length === 0 ? (
            <p className="text-xs text-zinc-500">
              No Etsy variation property for this category (or no category chosen yet) — use
              &quot;Custom&quot; instead.
            </p>
          ) : (
            <>
              <select
                value={draft.propertyId ?? ""}
                onChange={(e) => {
                  const id = e.target.value ? Number(e.target.value) : null;
                  const p = variationProperties.find((x) => x.propertyId === id);
                  setDraft(() => ({ source: "etsy", propertyId: id, name: p?.displayName ?? "", valueIds: [], values: [] }));
                }}
                className="h-9 w-full rounded-lg border border-black/10 bg-white px-2 text-sm outline-none focus:border-[#f56400] dark:border-white/15 dark:bg-zinc-950"
              >
                <option value="">Select a property…</option>
                {variationProperties.map((p) => (
                  <option key={p.propertyId} value={p.propertyId}>
                    {p.displayName}
                  </option>
                ))}
              </select>

              {selectedProp && (
                <div className="mt-2">
                  <PropertyPicker
                    property={selectedProp}
                    selected={{ name: selectedProp.displayName, valueIds: draft.valueIds, values: draft.values }}
                    onToggle={(_, pv) => toggleDraftValue(pv)}
                  />
                </div>
              )}
            </>
          )}
        </div>
      ) : (
        <div className="mt-3 space-y-2">
          <input
            type="text"
            value={draft.name}
            onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
            placeholder="Variation name (e.g. Paper type)"
            className="h-9 w-full rounded-lg border border-black/10 bg-white px-2 text-sm outline-none focus:border-[#f56400] dark:border-white/15 dark:bg-zinc-950"
          />
          <CustomOptionsInput values={draft.values} onChange={(values) => setDraft((d) => ({ ...d, values }))} />
        </div>
      )}

      <div className="mt-3 flex gap-2">
        <button
          type="button"
          disabled={!canCommit}
          onClick={onCommit}
          className="h-8 rounded-lg bg-[#f56400] px-3 text-xs font-medium text-white disabled:cursor-not-allowed disabled:opacity-40"
        >
          {isEditing ? "Save" : "Add"}
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

/** Chip input for hand-typed custom variation options — same interaction as the Tags field above. */
function CustomOptionsInput({ values, onChange }: { values: string[]; onChange: (values: string[]) => void }) {
  const [draft, setDraft] = useState("");
  function add() {
    const t = draft.trim();
    if (!t) return;
    if (values.some((v) => v.toLowerCase() === t.toLowerCase())) {
      setDraft("");
      return;
    }
    onChange([...values, t]);
    setDraft("");
  }
  function remove(t: string) {
    onChange(values.filter((v) => v !== t));
  }
  return (
    <div className="flex flex-wrap items-center gap-1.5 rounded-lg border border-black/10 p-1.5 dark:border-white/15">
      {values.map((v) => (
        <span key={v} className="flex items-center gap-1 rounded-full bg-black/[.06] px-2 py-0.5 text-xs dark:bg-white/10">
          {v}
          <button type="button" onClick={() => remove(v)} aria-label={`Remove ${v} option`} className="text-zinc-500 hover:text-red-600">
            ×
          </button>
        </span>
      ))}
      <input
        type="text"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === ",") {
            e.preventDefault();
            add();
          }
        }}
        onBlur={add}
        placeholder={values.length === 0 ? "Type an option, press Enter…" : ""}
        className="min-w-[100px] flex-1 border-none bg-transparent px-1 py-0.5 text-sm outline-none"
      />
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
  const [disableValueId, setDisableValueId] = useState("");

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
              return (
                <tr
                  key={rowKey}
                  className={`border-t border-black/5 dark:border-white/10 ${enabled ? "" : "opacity-40"}`}
                >
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
