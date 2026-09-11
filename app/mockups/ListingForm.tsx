"use client";

import { useEffect, useMemo, useRef, useState } from "react";

/** The shape this form edits — read by the page when publishing `mode: "new"`. */
export interface ListingFormProperty {
  name: string;
  valueIds: number[];
  values: string[];
  scaleId?: number | null;
}
/** One property chosen as a variation dimension (color, size, ...). */
export interface ListingFormVariationProperty {
  propertyId: number;
  name: string;
  valueIds: number[];
  values: string[];
  /** "fiyat bu özelliğe göre değişsin" */
  priceVaries: boolean;
  /** "görsel bu özelliğe göre değişsin" */
  imageVaries: boolean;
}
/** Per-combination overrides in the variation table; blank falls back to the base price/quantity. */
export interface ListingFormVariationRow {
  price: string;
  quantity: string;
  sku: string;
}
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
  /** Up to 3 property ids, in selection order. */
  variationPropertyIds: number[];
  /** Keyed by property id. */
  variationProperties: Record<number, ListingFormVariationProperty>;
  /** Keyed by `valueIds.join(":")` (one id per selected variation property, in `variationPropertyIds` order). */
  variationRows: Record<string, ListingFormVariationRow>;
  /** Keyed by `${propertyId}:${valueId}`, valued with a design item id. */
  variationImages: Record<string, string>;
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
  variationPropertyIds: [],
  variationProperties: {},
  variationRows: {},
  variationImages: {},
};

const MAX_TAGS = 13;
const MAX_TAG_LENGTH = 20;
const MAX_TITLE_LENGTH = 140;
const MAX_VARIATION_PROPERTIES = 3;
const MAX_VARIATION_ROWS = 100; // mirrors the server's sanity cap

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
/** The subset of a design the Variations "image varies" picker needs. */
export interface DesignOption {
  id: string;
  name: string;
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
 * Listing-editing form: title, description, tags, category + category
 * properties + section, variations, price, and quantity/SKU — in the same
 * order as Etsy's own listing form. Values feed a draft listing on publish;
 * nothing here is sent to Etsy until then.
 */
export default function ListingForm({
  value,
  onChange,
  designs,
}: {
  value: ListingFormValue;
  onChange: (next: ListingFormValue) => void;
  /** Rendered designs, for the per-variation-value "image varies" picker. */
  designs: DesignOption[];
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
    const q = categoryQuery.trim().toLocaleLowerCase("tr-TR");
    const list = taxonomy ?? [];
    if (!q) return list.slice(0, 50);
    return list.filter((n) => n.path.toLocaleLowerCase("tr-TR").includes(q)).slice(0, 50);
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
  useEffect(() => {
    fetch("/api/etsy/sections")
      .then((res) => (res.ok ? res.json() : null))
      .then((body: { sections?: ShopSectionOption[] } | null) => setSections(body?.sections ?? []))
      .catch(() => setSections([]));
  }, []);

  const inputCls =
    "w-full rounded-lg border border-black/10 bg-white px-3 text-sm outline-none focus:border-[#f56400] dark:border-white/15 dark:bg-zinc-950";

  return (
    <div className="rounded-xl border border-black/10 bg-white p-4 dark:border-white/15 dark:bg-zinc-950">
      <h2 className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
        Listing bilgileri
      </h2>
      <p className="mt-0.5 text-xs text-zinc-500">
        Bu değerler &quot;Yeni taslak&quot; ile Etsy&apos;ye gönderirken kullanılır.
      </p>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        {/* ---- 1. title ---- */}
        <label className="block text-sm lg:col-span-2">
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
            placeholder="Örn. Miami Skyline Wall Art Print"
            className={`${inputCls} mt-1 h-10`}
          />
        </label>

        {/* ---- 2. description ---- */}
        <label className="block text-sm lg:col-span-2">
          <span className="text-xs text-zinc-500">Description</span>
          <textarea
            rows={5}
            value={value.description}
            onChange={(e) => patch({ description: e.target.value })}
            placeholder="Ürünü tarif et…"
            className={`${inputCls} mt-1 resize-y py-2`}
          />
        </label>

        {/* ---- 3. tags ---- */}
        <div className="text-sm lg:col-span-2">
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
                  aria-label={`${t} etiketini kaldır`}
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
                placeholder={value.tags.length === 0 ? "etiket yaz, Enter'a bas…" : ""}
                className="min-w-[100px] flex-1 border-none bg-transparent px-1 py-0.5 text-sm outline-none"
              />
            )}
          </div>
        </div>

        {/* ---- 4. details ---- */}
        <div className="lg:col-span-2">
          <span className="text-xs text-zinc-500">Details</span>

          <div ref={categoryRootRef} className="relative mt-1">
            <button
              type="button"
              onClick={() => setCategoryOpen((o) => !o)}
              className={`${inputCls} flex h-10 items-center justify-between text-left`}
            >
              <span className={value.taxonomyPath ? "" : "text-zinc-400"}>
                {value.taxonomyPath || "Kategori seç…"}
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
                    placeholder="Kategori ara… (accessories, jewelry, weddings…)"
                    className="h-8 w-full rounded-md border border-black/10 bg-white px-2 text-sm outline-none focus:border-[#f56400] dark:border-white/15 dark:bg-zinc-900"
                  />
                </div>
                <ul className="max-h-72 overflow-y-auto py-1">
                  {taxonomyLoading && (
                    <li className="px-2 py-3 text-center text-xs text-zinc-500">
                      Kategoriler yükleniyor…
                    </li>
                  )}
                  {!taxonomyLoading && categoryRows.length === 0 && (
                    <li className="px-2 py-3 text-center text-xs text-zinc-500">
                      Eşleşen kategori yok.
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
                              variationPropertyIds: [],
                              variationProperties: {},
                              variationRows: {},
                              variationImages: {},
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
            <p className="mt-2 text-xs text-zinc-500">Kategori özellikleri yükleniyor…</p>
          )}

          {!propertiesLoading && attributeProperties.length > 0 && (
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
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

          <label className="mt-3 block text-sm">
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
              <option value="">Section yok</option>
              {(sections ?? []).map((s) => (
                <option key={s.shopSectionId} value={s.shopSectionId}>
                  {s.title}
                </option>
              ))}
            </select>
          </label>
        </div>

        {/* ---- 5. variations ---- */}
        {variationProperties.length > 0 && (
          <VariationsSection
            variationProperties={variationProperties}
            value={value}
            patch={patch}
            designs={designs}
          />
        )}

        {/* ---- 6. price ---- */}
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

        {/* ---- 7. inventory: quantity + sku side by side (no-variation fallback) ---- */}
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
              placeholder="isteğe bağlı"
              className={`${inputCls} mt-1 h-10`}
            />
          </label>
        </div>
      </div>
    </div>
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
    const q = query.trim().toLocaleLowerCase("tr-TR");
    const all = property.possibleValues;
    const filtered = q
      ? all.filter((pv) => pv.name.toLocaleLowerCase("tr-TR").includes(q))
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
            placeholder="Ara…"
            className="h-7 w-full rounded-md bg-transparent px-1.5 text-xs outline-none"
          />
        </div>
        <div className="h-36 overflow-y-auto p-1">
          {rows.length === 0 && (
            <p className="px-2 py-3 text-center text-xs text-zinc-400">Sonuç yok.</p>
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
        <span className="font-medium">Seçili:</span>{" "}
        {selected?.values.length ? selected.values.join(", ") : "—"}
      </p>
    </div>
  );
}

const EMPTY_VARIATION_ROW: ListingFormVariationRow = { price: "", quantity: "", sku: "" };

/** One property-value combination — one row of the variation table. */
interface VariationCombo {
  valueIds: number[];
  values: string[];
}

/**
 * Variations section: pick up to {@link MAX_VARIATION_PROPERTIES} properties
 * that support variations, pick each one's values with the same
 * {@link PropertyPicker} (always multi-select here), then edit the resulting
 * combination grid — bulk-fill at the top, price/quantity/SKU per row, and
 * per-property "price varies" / "image varies" toggles. Sent on publish via
 * the Etsy Inventory API (`PUT .../inventory`), not covered by
 * `createDraftListing`.
 */
function VariationsSection({
  variationProperties,
  value,
  patch,
  designs,
}: {
  variationProperties: TaxonomyProperty[];
  value: ListingFormValue;
  patch: (partial: Partial<ListingFormValue>) => void;
  designs: DesignOption[];
}) {
  const selectedIds = value.variationPropertyIds;

  function toggleVariationProperty(prop: TaxonomyProperty) {
    const isSelected = selectedIds.includes(prop.propertyId);
    if (isSelected) {
      const nextProps = { ...value.variationProperties };
      delete nextProps[prop.propertyId];
      patch({
        variationPropertyIds: selectedIds.filter((id) => id !== prop.propertyId),
        variationProperties: nextProps,
      });
      return;
    }
    if (selectedIds.length >= MAX_VARIATION_PROPERTIES) return;
    patch({
      variationPropertyIds: [...selectedIds, prop.propertyId],
      variationProperties: {
        ...value.variationProperties,
        [prop.propertyId]: {
          propertyId: prop.propertyId,
          name: prop.displayName,
          valueIds: [],
          values: [],
          priceVaries: false,
          imageVaries: false,
        },
      },
    });
  }

  function toggleVariationValue(
    prop: TaxonomyProperty,
    pv: { valueId: number | null; name: string },
  ) {
    if (pv.valueId == null) return;
    const current = value.variationProperties[prop.propertyId];
    if (!current) return;
    const nextIdSet = new Set(current.valueIds);
    if (nextIdSet.has(pv.valueId)) nextIdSet.delete(pv.valueId);
    else nextIdSet.add(pv.valueId);
    // Keep the source order (matches Etsy's `possible_values` order) rather
    // than click order, so the table's columns stay stable.
    const nextIds: number[] = [];
    const nextValues: string[] = [];
    for (const cand of prop.possibleValues) {
      if (cand.valueId != null && nextIdSet.has(cand.valueId)) {
        nextIds.push(cand.valueId);
        nextValues.push(cand.name);
      }
    }
    patch({
      variationProperties: {
        ...value.variationProperties,
        [prop.propertyId]: { ...current, valueIds: nextIds, values: nextValues },
      },
    });
  }

  const dims = useMemo(
    () =>
      selectedIds
        .map((id) => value.variationProperties[id])
        .filter((p): p is ListingFormVariationProperty => !!p && p.valueIds.length > 0),
    [selectedIds, value.variationProperties],
  );

  const combos = useMemo<VariationCombo[]>(() => {
    if (dims.length === 0) return [];
    let acc: VariationCombo[] = [{ valueIds: [], values: [] }];
    for (const dim of dims) {
      const next: VariationCombo[] = [];
      for (const a of acc) {
        for (let i = 0; i < dim.valueIds.length; i++) {
          next.push({
            valueIds: [...a.valueIds, dim.valueIds[i]],
            values: [...a.values, dim.values[i]],
          });
        }
      }
      acc = next;
    }
    return acc.slice(0, MAX_VARIATION_ROWS);
  }, [dims]);
  const combosTruncated = dims.length > 0 && combos.length >= MAX_VARIATION_ROWS;

  function patchRow(key: string, partial: Partial<ListingFormVariationRow>) {
    const current = value.variationRows[key] ?? EMPTY_VARIATION_ROW;
    patch({ variationRows: { ...value.variationRows, [key]: { ...current, ...partial } } });
  }

  // ---- bulk-fill ----
  const [bulkPrice, setBulkPrice] = useState("");
  const [bulkQuantity, setBulkQuantity] = useState("");
  function applyBulkPrice() {
    if (!bulkPrice.trim()) return;
    const nextRows = { ...value.variationRows };
    for (const c of combos) {
      const key = c.valueIds.join(":");
      nextRows[key] = { ...(nextRows[key] ?? EMPTY_VARIATION_ROW), price: bulkPrice };
    }
    patch({ variationRows: nextRows });
  }
  function applyBulkQuantity() {
    if (!bulkQuantity.trim()) return;
    const nextRows = { ...value.variationRows };
    for (const c of combos) {
      const key = c.valueIds.join(":");
      nextRows[key] = { ...(nextRows[key] ?? EMPTY_VARIATION_ROW), quantity: bulkQuantity };
    }
    patch({ variationRows: nextRows });
  }

  const inputCls =
    "w-full rounded-lg border border-black/10 bg-white px-3 text-sm outline-none focus:border-[#f56400] dark:border-white/15 dark:bg-zinc-950";

  return (
    <div className="lg:col-span-2">
      <span className="text-xs text-zinc-500">Variations</span>

      <div className="mt-1 flex flex-wrap gap-1.5">
        {variationProperties.map((prop) => {
          const active = selectedIds.includes(prop.propertyId);
          const disabled = !active && selectedIds.length >= MAX_VARIATION_PROPERTIES;
          return (
            <button
              key={prop.propertyId}
              type="button"
              disabled={disabled}
              onClick={() => toggleVariationProperty(prop)}
              className={`rounded-full border px-3 py-1 text-xs ${
                active
                  ? "border-[#f56400] bg-[#f56400]/10 text-[#f56400]"
                  : disabled
                    ? "cursor-not-allowed border-black/10 text-zinc-400 dark:border-white/10"
                    : "border-black/10 hover:bg-black/[.04] dark:border-white/15 dark:hover:bg-white/[.06]"
              }`}
            >
              {prop.displayName}
            </button>
          );
        })}
      </div>
      <p className="mt-1 text-xs text-zinc-500">En fazla {MAX_VARIATION_PROPERTIES} varyasyon seçilebilir.</p>

      {selectedIds.length > 0 && (
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          {selectedIds.map((id) => {
            const prop = variationProperties.find((p) => p.propertyId === id);
            const sel = value.variationProperties[id];
            if (!prop || !sel) return null;
            return (
              <div key={id}>
                <PropertyPicker property={prop} selected={sel} onToggle={toggleVariationValue} />
                <div className="mt-1.5 flex flex-col gap-1">
                  <label className="flex items-center gap-1.5 text-xs text-zinc-600 dark:text-zinc-400">
                    <input
                      type="checkbox"
                      checked={sel.priceVaries}
                      onChange={(e) =>
                        patch({
                          variationProperties: {
                            ...value.variationProperties,
                            [id]: { ...sel, priceVaries: e.target.checked },
                          },
                        })
                      }
                      className="accent-[#f56400]"
                    />
                    Fiyat bu özelliğe göre değişsin
                  </label>
                  <label className="flex items-center gap-1.5 text-xs text-zinc-600 dark:text-zinc-400">
                    <input
                      type="checkbox"
                      checked={sel.imageVaries}
                      onChange={(e) =>
                        patch({
                          variationProperties: {
                            ...value.variationProperties,
                            [id]: { ...sel, imageVaries: e.target.checked },
                          },
                        })
                      }
                      className="accent-[#f56400]"
                    />
                    Görsel bu özelliğe göre değişsin
                  </label>

                  {sel.imageVaries && sel.valueIds.length > 0 && (
                    <div className="mt-1 space-y-1 rounded-lg border border-black/10 p-1.5 dark:border-white/15">
                      {sel.values.map((vname, i) => {
                        const valueId = sel.valueIds[i];
                        const imgKey = `${id}:${valueId}`;
                        return (
                          <div key={valueId} className="flex items-center justify-between gap-2 text-xs">
                            <span className="truncate">{vname}</span>
                            <select
                              value={value.variationImages[imgKey] ?? ""}
                              onChange={(e) =>
                                patch({
                                  variationImages: { ...value.variationImages, [imgKey]: e.target.value },
                                })
                              }
                              className="h-7 rounded-md border border-black/10 bg-white px-1 text-xs outline-none dark:border-white/15 dark:bg-zinc-900"
                            >
                              <option value="">Tasarım seç…</option>
                              {designs.map((d) => (
                                <option key={d.id} value={d.id}>
                                  {d.name}
                                </option>
                              ))}
                            </select>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {combos.length > 0 && (
        <div className="mt-4">
          <div className="flex flex-wrap items-end gap-2">
            <label className="text-xs">
              <span className="block text-zinc-500">Tüm satırlara fiyat uygula</span>
              <div className="mt-1 flex gap-1">
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={bulkPrice}
                  onChange={(e) => setBulkPrice(e.target.value)}
                  placeholder="0.00"
                  className={`${inputCls} h-8 w-24`}
                />
                <button
                  type="button"
                  onClick={applyBulkPrice}
                  className="h-8 rounded-lg border border-black/10 px-2 text-xs hover:bg-black/[.04] dark:border-white/15 dark:hover:bg-white/[.06]"
                >
                  Uygula
                </button>
              </div>
            </label>
            <label className="text-xs">
              <span className="block text-zinc-500">Tüm satırlara adet uygula</span>
              <div className="mt-1 flex gap-1">
                <input
                  type="number"
                  min="0"
                  step="1"
                  value={bulkQuantity}
                  onChange={(e) => setBulkQuantity(e.target.value)}
                  placeholder="1"
                  className={`${inputCls} h-8 w-24`}
                />
                <button
                  type="button"
                  onClick={applyBulkQuantity}
                  className="h-8 rounded-lg border border-black/10 px-2 text-xs hover:bg-black/[.04] dark:border-white/15 dark:hover:bg-white/[.06]"
                >
                  Uygula
                </button>
              </div>
            </label>
          </div>

          <div className="mt-2 max-h-80 overflow-auto rounded-lg border border-black/10 dark:border-white/15">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-zinc-50 dark:bg-zinc-900">
                <tr>
                  {dims.map((d) => (
                    <th key={d.propertyId} className="px-2 py-1.5 text-left font-medium text-zinc-500">
                      {d.name}
                    </th>
                  ))}
                  <th className="px-2 py-1.5 text-left font-medium text-zinc-500">Fiyat</th>
                  <th className="px-2 py-1.5 text-left font-medium text-zinc-500">Adet</th>
                  <th className="px-2 py-1.5 text-left font-medium text-zinc-500">SKU</th>
                </tr>
              </thead>
              <tbody>
                {combos.map((c) => {
                  const key = c.valueIds.join(":");
                  const row = value.variationRows[key] ?? EMPTY_VARIATION_ROW;
                  return (
                    <tr key={key} className="border-t border-black/5 dark:border-white/10">
                      {c.values.map((v, i) => (
                        <td key={i} className="px-2 py-1">
                          {v}
                        </td>
                      ))}
                      <td className="px-2 py-1">
                        <input
                          type="number"
                          min="0"
                          step="0.01"
                          value={row.price}
                          onChange={(e) => patchRow(key, { price: e.target.value })}
                          placeholder={value.price || "0.00"}
                          className="h-7 w-20 rounded-md border border-black/10 bg-white px-1.5 outline-none focus:border-[#f56400] dark:border-white/15 dark:bg-zinc-950"
                        />
                      </td>
                      <td className="px-2 py-1">
                        <input
                          type="number"
                          min="0"
                          step="1"
                          value={row.quantity}
                          onChange={(e) => patchRow(key, { quantity: e.target.value })}
                          placeholder={value.quantity || "1"}
                          className="h-7 w-16 rounded-md border border-black/10 bg-white px-1.5 outline-none focus:border-[#f56400] dark:border-white/15 dark:bg-zinc-950"
                        />
                      </td>
                      <td className="px-2 py-1">
                        <input
                          type="text"
                          value={row.sku}
                          onChange={(e) => patchRow(key, { sku: e.target.value })}
                          placeholder="isteğe bağlı"
                          className="h-7 w-28 rounded-md border border-black/10 bg-white px-1.5 outline-none focus:border-[#f56400] dark:border-white/15 dark:bg-zinc-950"
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {combosTruncated && (
            <p className="mt-1 text-xs text-amber-600">
              Kombinasyon sayısı {MAX_VARIATION_ROWS} ile sınırlı — daha az değer seçmeyi düşün.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
