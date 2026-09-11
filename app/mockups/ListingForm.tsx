"use client";

import { useEffect, useMemo, useRef, useState } from "react";

/** The shape this form edits — read by the page when publishing `mode: "new"`. */
export interface ListingFormProperty {
  name: string;
  valueIds: number[];
  values: string[];
  scaleId?: number | null;
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
interface TaxonomyProperty {
  propertyId: number;
  name: string;
  displayName: string;
  isRequired: boolean;
  isMultivalued: boolean;
  maxValuesAllowed: number | null;
  possibleValues: { valueId: number | null; name: string }[];
}
interface ShopSectionOption {
  shopSectionId: number;
  title: string;
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
 * properties + section, price, and quantity/SKU — in the same order as
 * Etsy's own listing form. Values feed a draft listing on publish; nothing
 * here is sent to Etsy until then. Variations are not covered yet.
 */
export default function ListingForm({
  value,
  onChange,
}: {
  value: ListingFormValue;
  onChange: (next: ListingFormValue) => void;
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
        Varyasyonlar henüz yok — sonraki adımda eklenecek.
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
                              properties: {}, // a new category has different properties
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

          {!propertiesLoading && properties.length > 0 && (
            <div className="mt-3 space-y-3">
              {properties.map((prop) => {
                const picked = value.properties[prop.propertyId]?.valueIds ?? [];
                return (
                  <div key={prop.propertyId}>
                    <span className="text-xs text-zinc-500">
                      {prop.displayName}
                      {prop.isRequired ? " *" : ""}
                    </span>
                    <div className="mt-1 flex flex-wrap gap-1.5">
                      {prop.possibleValues.map((pv) => {
                        const selected = pv.valueId != null && picked.includes(pv.valueId);
                        return (
                          <button
                            key={pv.valueId ?? pv.name}
                            type="button"
                            onClick={() => togglePropertyValue(prop, pv)}
                            className={`h-7 rounded-full px-2.5 text-xs font-medium ${
                              selected
                                ? "bg-black text-white dark:bg-white dark:text-black"
                                : "border border-black/10 text-zinc-600 dark:border-white/15 dark:text-zinc-400"
                            }`}
                          >
                            {pv.name}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
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

        {/* ---- 5. price ---- */}
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

        {/* ---- 6. inventory: quantity + sku side by side ---- */}
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
