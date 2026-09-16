"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  BULK_SECTIONS,
  CHARACTER_LIMITS,
  MAX_TAGS,
  MAX_TAG_LENGTH,
  remainingCharacters,
  type BulkFieldKey,
  type BulkListingPatch,
} from "@/lib/etsy/bulk-edit";

/** One listing as `GET /api/etsy/listings/bulk` returns it. */
interface BulkListingDetail {
  listingId: number;
  title: string;
  description: string;
  tags: string[];
  state: string;
  url: string;
  thumbnailUrl: string | null;
  shopSectionId: number | null;
  shippingProfileId: number | null;
  shouldAutoRenew: boolean;
  isTaxable: boolean;
  price: number | null;
  quantity: number;
  sku: string;
  hasVariations: boolean;
}

interface SectionOption {
  shopSectionId: number;
  title: string;
}
interface ShippingProfileOption {
  shippingProfileId: number;
  title: string;
}
interface SaveResult {
  listingId: number;
  ok: boolean;
  error?: string;
}

/** The editable value of one field, in the shape the inputs use. */
type FieldValue = string | boolean | string[];

async function errorFrom(res: Response): Promise<string> {
  const body = (await res.json().catch(() => null)) as { error?: string } | null;
  return body?.error || `Request failed (${res.status})`;
}

/** The listing's own stored value for `field`, as the inputs represent it. */
function originalValue(listing: BulkListingDetail, field: BulkFieldKey): FieldValue {
  switch (field) {
    case "title":
      return listing.title;
    case "description":
      return listing.description;
    case "tags":
      return listing.tags;
    case "shopSectionId":
      return listing.shopSectionId == null ? "" : String(listing.shopSectionId);
    case "shippingProfileId":
      return listing.shippingProfileId == null ? "" : String(listing.shippingProfileId);
    case "shouldAutoRenew":
      return listing.shouldAutoRenew;
    case "isTaxable":
      return listing.isTaxable;
    case "price":
      return listing.price == null ? "" : listing.price.toFixed(2);
    case "quantity":
      return String(listing.quantity);
    case "sku":
      return listing.sku;
  }
}

/**
 * Turn one edited field into its patch entry, or null when the typed value
 * isn't usable yet (an empty number box, an unpicked dropdown) — an
 * in-progress value is simply not part of the save.
 */
function patchEntry(field: BulkFieldKey, value: FieldValue): BulkListingPatch | null {
  switch (field) {
    case "title":
      return typeof value === "string" && value.trim() ? { title: value.trim() } : null;
    case "description":
      return typeof value === "string" ? { description: value } : null;
    case "tags":
      return Array.isArray(value) && value.length > 0 ? { tags: value } : null;
    case "shopSectionId": {
      const id = Number.parseInt(String(value), 10);
      return Number.isInteger(id) && id > 0 ? { shopSectionId: id } : null;
    }
    case "shippingProfileId": {
      const id = Number.parseInt(String(value), 10);
      return Number.isInteger(id) && id > 0 ? { shippingProfileId: id } : null;
    }
    case "shouldAutoRenew":
      return typeof value === "boolean" ? { shouldAutoRenew: value } : null;
    case "isTaxable":
      return typeof value === "boolean" ? { isTaxable: value } : null;
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
  }
}

function sameValue(a: FieldValue, b: FieldValue): boolean {
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => v === b[i]);
  }
  return a === b;
}

const inputCls =
  "w-full rounded-lg border border-black/10 bg-white px-2 text-sm outline-none focus:border-primary dark:border-white/15 dark:bg-zinc-950";

/**
 * The bulk editor: every selected listing on its own row, each edited
 * individually, with an explicit "apply to all" for writing one value across
 * the lot. Nothing reaches Etsy until Save all changes is pressed.
 */
export default function BulkEditor({ listingIds }: { listingIds: number[] }) {
  const [listings, setListings] = useState<BulkListingDetail[] | null>(null);
  const [missing, setMissing] = useState<number[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [sections, setSections] = useState<SectionOption[]>([]);
  const [shippingProfiles, setShippingProfiles] = useState<ShippingProfileOption[]>([]);

  const [activeSection, setActiveSection] = useState(BULK_SECTIONS[0].key);
  const [search, setSearch] = useState("");
  /** Which listings a save writes to. Every selected listing starts included. */
  const [targeted, setTargeted] = useState<Record<number, boolean>>({});
  /** Edited values, per listing and field. Absent means "untouched". */
  const [edited, setEdited] = useState<Record<number, Partial<Record<BulkFieldKey, FieldValue>>>>({});
  const [applyToAll, setApplyToAll] = useState<Partial<Record<BulkFieldKey, FieldValue>>>({});
  const [saving, setSaving] = useState(false);
  const [results, setResults] = useState<SaveResult[] | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  const idsKey = listingIds.join(",");

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

  useEffect(() => {
    fetch("/api/etsy/sections")
      .then((res) => (res.ok ? res.json() : null))
      .then((body: { sections?: SectionOption[] } | null) => setSections(body?.sections ?? []))
      .catch(() => setSections([]));
    fetch("/api/etsy/shipping-profiles")
      .then((res) => (res.ok ? res.json() : null))
      .then((body: { profiles?: ShippingProfileOption[] } | null) =>
        setShippingProfiles(body?.profiles ?? []),
      )
      .catch(() => setShippingProfiles([]));
  }, []);

  const section = BULK_SECTIONS.find((s) => s.key === activeSection) ?? BULK_SECTIONS[0];

  const valueOf = useCallback(
    (listing: BulkListingDetail, field: BulkFieldKey): FieldValue =>
      edited[listing.listingId]?.[field] ?? originalValue(listing, field),
    [edited],
  );

  function setValue(listingId: number, field: BulkFieldKey, value: FieldValue) {
    setEdited((prev) => ({
      ...prev,
      [listingId]: { ...prev[listingId], [field]: value },
    }));
  }

  /** Write one value into every targeted listing — the explicit apply-to-all. */
  function applyValueToAll(field: BulkFieldKey, value: FieldValue) {
    setEdited((prev) => {
      const next = { ...prev };
      for (const listing of listings ?? []) {
        if (!targeted[listing.listingId]) continue;
        if (INVENTORY_LOCKED.has(field) && listing.hasVariations) continue;
        next[listing.listingId] = { ...next[listing.listingId], [field]: value };
      }
      return next;
    });
  }

  /** The patch that would be written to one listing: only fields actually changed. */
  const patchFor = useCallback(
    (listing: BulkListingDetail): BulkListingPatch => {
      const patch: BulkListingPatch = {};
      const rowEdits = edited[listing.listingId];
      if (!rowEdits) return patch;
      for (const [field, value] of Object.entries(rowEdits) as [BulkFieldKey, FieldValue][]) {
        if (sameValue(value, originalValue(listing, field))) continue;
        if (INVENTORY_LOCKED.has(field) && listing.hasVariations) continue;
        const entry = patchEntry(field, value);
        if (entry) Object.assign(patch, entry);
      }
      return patch;
    },
    [edited],
  );

  const updates = useMemo(() => {
    return (listings ?? [])
      .filter((l) => targeted[l.listingId])
      .map((l) => ({ listingId: l.listingId, patch: patchFor(l) }))
      .filter((u) => Object.keys(u.patch).length > 0);
  }, [listings, targeted, patchFor]);

  const visible = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const all = listings ?? [];
    return needle ? all.filter((l) => l.title.toLowerCase().includes(needle)) : all;
  }, [listings, search]);

  async function save() {
    setSaving(true);
    setSaveError(null);
    setResults(null);
    try {
      const res = await fetch("/api/etsy/listings/bulk/save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ updates }),
      });
      if (!res.ok) throw new Error(await errorFrom(res));
      const body = (await res.json()) as { results: SaveResult[] };
      setResults(body.results);
      // Saved values are now the listings' own values — clear the edits that landed.
      const savedIds = new Set(body.results.filter((r) => r.ok).map((r) => r.listingId));
      setListings((prev) =>
        (prev ?? []).map((l) => {
          if (!savedIds.has(l.listingId)) return l;
          const patch = patchFor(l);
          return {
            ...l,
            ...(patch.title !== undefined ? { title: patch.title } : {}),
            ...(patch.description !== undefined ? { description: patch.description } : {}),
            ...(patch.tags !== undefined ? { tags: patch.tags } : {}),
            ...(patch.shopSectionId !== undefined ? { shopSectionId: patch.shopSectionId } : {}),
            ...(patch.shippingProfileId !== undefined
              ? { shippingProfileId: patch.shippingProfileId }
              : {}),
            ...(patch.shouldAutoRenew !== undefined
              ? { shouldAutoRenew: patch.shouldAutoRenew }
              : {}),
            ...(patch.isTaxable !== undefined ? { isTaxable: patch.isTaxable } : {}),
            ...(patch.price !== undefined ? { price: patch.price } : {}),
            ...(patch.quantity !== undefined ? { quantity: patch.quantity } : {}),
            ...(patch.sku !== undefined ? { sku: patch.sku } : {}),
          };
        }),
      );
      setEdited((prev) => {
        const next = { ...prev };
        for (const id of savedIds) delete next[id];
        return next;
      });
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Save failed.");
    } finally {
      setSaving(false);
    }
  }

  const resultFor = (listingId: number) => results?.find((r) => r.listingId === listingId);
  const count = (listings ?? []).length;

  return (
    <div className="min-h-screen bg-zinc-50 font-sans dark:bg-black">
      <div className="mx-auto w-full max-w-[96rem] px-4 py-8 sm:px-6">
        {/* ---- header ---- */}
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
              onClick={save}
              disabled={saving || updates.length === 0}
              className="inline-flex h-9 items-center rounded-full bg-primary px-4 text-sm font-medium text-white transition-colors hover:bg-primary-dark disabled:opacity-40"
            >
              {saving
                ? "Saving…"
                : `Save all changes${updates.length > 0 ? ` (${updates.length})` : ""}`}
            </button>
          </div>
        </div>
        <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
          Changes are written to Etsy only when you save. Untick a row to leave that listing alone.
        </p>

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
          <div role="status" className="mt-4 rounded-xl border border-black/10 bg-white px-4 py-3 text-sm dark:border-white/15 dark:bg-zinc-950">
            Saved {results.filter((r) => r.ok).length} of {results.length} listings.
            {results.some((r) => !r.ok) && " Rows that failed keep their changes below."}
          </div>
        )}

        <div className="mt-6 flex flex-col gap-6 lg:flex-row">
          {/* ---- left sidebar: which field group is being edited ---- */}
          <aside className="lg:w-52 lg:shrink-0">
            <nav className="space-y-0.5">
              {BULK_SECTIONS.map((s) => (
                <button
                  key={s.key}
                  type="button"
                  onClick={() => setActiveSection(s.key)}
                  className={`flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-sm transition-colors ${
                    activeSection === s.key
                      ? "bg-black text-white dark:bg-white dark:text-black"
                      : "text-zinc-600 hover:bg-black/[.04] dark:text-zinc-400 dark:hover:bg-white/[.06]"
                  }`}
                >
                  {s.label}
                </button>
              ))}
            </nav>
          </aside>

          {/* ---- main: one row per listing ---- */}
          <div className="min-w-0 flex-1">
            <label className="block text-sm">
              <span className="sr-only">Search listings</span>
              <input
                type="search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search these listings by title…"
                className={`${inputCls} h-10`}
              />
            </label>

            {section.fields.length > 0 && (
              <ApplyToAll
                section={section.label}
                fields={section.fields}
                values={applyToAll}
                sections={sections}
                shippingProfiles={shippingProfiles}
                onChange={(field, value) => setApplyToAll((p) => ({ ...p, [field]: value }))}
                onApply={(field) => {
                  const value = applyToAll[field];
                  if (value !== undefined) applyValueToAll(field, value);
                }}
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
                const changed = Object.keys(rowPatch).length;
                return (
                  <div
                    key={listing.listingId}
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

                    <div className="mt-3 space-y-3 pl-7">
                      {section.fields.length === 0 ? (
                        <MediaSection listing={listing} />
                      ) : (
                        section.fields.map((field) => (
                          <FieldInput
                            key={field}
                            field={field}
                            listing={listing}
                            value={valueOf(listing, field)}
                            sections={sections}
                            shippingProfiles={shippingProfiles}
                            onChange={(value) => setValue(listing.listingId, field, value)}
                          />
                        ))
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

/** Inventory fields a variation listing can't take from a single row. */
const INVENTORY_LOCKED = new Set<BulkFieldKey>(["price", "quantity", "sku"]);

const FIELD_LABELS: Record<BulkFieldKey, string> = {
  title: "Title",
  description: "Description",
  tags: "Tags",
  shopSectionId: "Shop section",
  shouldAutoRenew: "Renew automatically",
  isTaxable: "Charge tax",
  price: "Price",
  quantity: "Quantity",
  sku: "SKU",
  shippingProfileId: "Shipping profile",
};

/** Media has nothing safely bulk-editable — show what's there and link to the editor. */
function MediaSection({ listing }: { listing: BulkListingDetail }) {
  return (
    <p className="text-xs text-zinc-500 dark:text-zinc-400">
      Photos are edited per listing.{" "}
      <Link
        href={`/mockups?mode=existing&listingId=${listing.listingId}&title=${encodeURIComponent(listing.title)}`}
        className="font-medium text-primary underline underline-offset-2"
      >
        Open in the listing editor
      </Link>{" "}
      to add or replace images.
    </p>
  );
}

/** The counter shown under a field Etsy actually limits. */
function CharacterCounter({ field, value }: { field: BulkFieldKey; value: string }) {
  const remaining = remainingCharacters(field, value);
  if (remaining == null) return null;
  return (
    <span
      className={`mt-0.5 block text-right font-mono text-[11px] ${
        remaining < 0 ? "text-red-600 dark:text-red-400" : "text-zinc-500"
      }`}
    >
      {remaining} left
    </span>
  );
}

function FieldInput({
  field,
  listing,
  value,
  sections,
  shippingProfiles,
  onChange,
}: {
  field: BulkFieldKey;
  listing: BulkListingDetail;
  value: FieldValue;
  sections: SectionOption[];
  shippingProfiles: ShippingProfileOption[];
  onChange: (value: FieldValue) => void;
}) {
  const label = FIELD_LABELS[field];
  const id = `${field}-${listing.listingId}`;
  // Every row shows the same visible "Title"/"Price"/… caption, so the
  // control's own accessible name carries the listing it belongs to —
  // otherwise a screen reader (and a test) hears one field repeated N times.
  const ariaLabel = `${label} for ${listing.title}`;

  if (INVENTORY_LOCKED.has(field) && listing.hasVariations) {
    return (
      <p className="text-xs text-zinc-500 dark:text-zinc-400">
        {label} varies by variation on this listing — edit it in the listing editor.
      </p>
    );
  }

  if (field === "tags") {
    return (
      <TagsInput
        id={id}
        ariaLabel={ariaLabel}
        tags={Array.isArray(value) ? value : []}
        onChange={(tags) => onChange(tags)}
      />
    );
  }

  if (field === "description") {
    return (
      <label htmlFor={id} className="block text-sm">
        <span className="text-xs text-zinc-500">{label}</span>
        <textarea
          id={id}
          aria-label={ariaLabel}
          rows={4}
          value={String(value)}
          onChange={(e) => onChange(e.target.value)}
          className={`${inputCls} mt-1 resize-y py-2`}
        />
      </label>
    );
  }

  if (field === "shouldAutoRenew" || field === "isTaxable") {
    return (
      <label htmlFor={id} className="flex items-center gap-2 text-sm">
        <input
          id={id}
          aria-label={ariaLabel}
          type="checkbox"
          checked={value === true}
          onChange={(e) => onChange(e.target.checked)}
          className="h-4 w-4 cursor-pointer accent-primary"
        />
        <span className="text-xs text-zinc-500">{label}</span>
      </label>
    );
  }

  if (field === "shopSectionId" || field === "shippingProfileId") {
    const options =
      field === "shopSectionId"
        ? sections.map((s) => ({ value: String(s.shopSectionId), label: s.title }))
        : shippingProfiles.map((p) => ({ value: String(p.shippingProfileId), label: p.title }));
    return (
      <label htmlFor={id} className="block text-sm">
        <span className="text-xs text-zinc-500">{label}</span>
        <select
          id={id}
          aria-label={ariaLabel}
          value={String(value)}
          onChange={(e) => onChange(e.target.value)}
          className={`${inputCls} mt-1 h-9`}
        >
          <option value="">Keep as is</option>
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </label>
    );
  }

  const numeric = field === "price" || field === "quantity";
  const limit = CHARACTER_LIMITS[field];
  // The counter sits outside the <label> deliberately: inside, its text
  // becomes part of the field's accessible name ("Title140 left").
  return (
    <div className="text-sm">
      <label htmlFor={id} className="block text-xs text-zinc-500">
        {label}
      </label>
      <input
        id={id}
        aria-label={ariaLabel}
        type={numeric ? "number" : "text"}
        inputMode={field === "quantity" ? "numeric" : undefined}
        step={field === "price" ? "0.01" : undefined}
        min={numeric ? "0" : undefined}
        maxLength={limit}
        value={String(value)}
        onChange={(e) => onChange(e.target.value)}
        className={`${inputCls} mt-1 h-9`}
      />
      <CharacterCounter field={field} value={String(value)} />
    </div>
  );
}

/** Tag chips with Etsy's own count and per-tag length caps. */
function TagsInput({
  id,
  ariaLabel,
  tags,
  onChange,
}: {
  id: string;
  ariaLabel: string;
  tags: string[];
  onChange: (tags: string[]) => void;
}) {
  const [draft, setDraft] = useState("");

  function addTag() {
    const tag = draft.trim().slice(0, MAX_TAG_LENGTH);
    setDraft("");
    if (!tag || tags.length >= MAX_TAGS) return;
    if (tags.some((t) => t.toLowerCase() === tag.toLowerCase())) return;
    onChange([...tags, tag]);
  }

  return (
    <div className="text-sm">
      <span className="flex justify-between text-xs text-zinc-500">
        <span>Tags</span>
        <span className="font-mono">
          {tags.length}/{MAX_TAGS}
        </span>
      </span>
      <div className="mt-1 flex flex-wrap items-center gap-1.5 rounded-lg border border-black/10 p-1.5 dark:border-white/15">
        {tags.map((tag) => (
          <span
            key={tag}
            className="flex items-center gap-1 rounded-full bg-black/[.06] px-2 py-0.5 text-xs dark:bg-white/10"
          >
            {tag}
            <button
              type="button"
              onClick={() => onChange(tags.filter((t) => t !== tag))}
              aria-label={`Remove ${tag} tag`}
              className="text-zinc-500 hover:text-red-600"
            >
              ×
            </button>
          </span>
        ))}
        {tags.length < MAX_TAGS && (
          <input
            id={id}
            aria-label={ariaLabel}
            type="text"
            value={draft}
            maxLength={MAX_TAG_LENGTH}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === ",") {
                e.preventDefault();
                addTag();
              }
            }}
            onBlur={addTag}
            placeholder={tags.length === 0 ? "Type a tag, press Enter…" : ""}
            className="min-w-[100px] flex-1 border-none bg-transparent px-1 py-0.5 text-sm outline-none"
          />
        )}
      </div>
      <span className="mt-0.5 block text-right font-mono text-[11px] text-zinc-500">
        {MAX_TAG_LENGTH - draft.length} left in this tag
      </span>
    </div>
  );
}

/**
 * The explicit "write this value to every ticked listing" control — separate
 * from the per-row inputs, so one value is only ever spread across listings
 * when the user asks for it by name.
 */
function ApplyToAll({
  section,
  fields,
  values,
  sections,
  shippingProfiles,
  onChange,
  onApply,
}: {
  section: string;
  fields: readonly BulkFieldKey[];
  values: Partial<Record<BulkFieldKey, FieldValue>>;
  sections: SectionOption[];
  shippingProfiles: ShippingProfileOption[];
  onChange: (field: BulkFieldKey, value: FieldValue) => void;
  onApply: (field: BulkFieldKey) => void;
}) {
  return (
    <section
      aria-label={`Apply to all selected — ${section}`}
      className="mt-4 rounded-xl border border-dashed border-black/15 bg-white p-4 dark:border-white/20 dark:bg-zinc-950"
    >
      <h2 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
        Apply to all selected
      </h2>
      <div className="mt-2 space-y-2">
        {fields.map((field) => {
          const value = values[field];
          const id = `apply-all-${field}`;
          const ariaLabel = `${FIELD_LABELS[field]} to apply to all`;
          return (
            <div key={field} className="flex flex-wrap items-end gap-2">
              <div className="min-w-[12rem] flex-1">
                {field === "tags" ? (
                  <TagsInput
                    id={id}
                    ariaLabel={ariaLabel}
                    tags={Array.isArray(value) ? value : []}
                    onChange={(tags) => onChange(field, tags)}
                  />
                ) : field === "shouldAutoRenew" || field === "isTaxable" ? (
                  <label htmlFor={id} className="flex items-center gap-2 text-sm">
                    <input
                      id={id}
                      aria-label={ariaLabel}
                      type="checkbox"
                      checked={value === true}
                      onChange={(e) => onChange(field, e.target.checked)}
                      className="h-4 w-4 cursor-pointer accent-primary"
                    />
                    <span className="text-xs text-zinc-500">{FIELD_LABELS[field]}</span>
                  </label>
                ) : field === "shopSectionId" || field === "shippingProfileId" ? (
                  <label htmlFor={id} className="block text-sm">
                    <span className="text-xs text-zinc-500">{FIELD_LABELS[field]}</span>
                    <select
                      id={id}
                      aria-label={ariaLabel}
                      value={String(value ?? "")}
                      onChange={(e) => onChange(field, e.target.value)}
                      className={`${inputCls} mt-1 h-9`}
                    >
                      <option value="">Choose…</option>
                      {(field === "shopSectionId"
                        ? sections.map((s) => ({ value: String(s.shopSectionId), label: s.title }))
                        : shippingProfiles.map((p) => ({
                            value: String(p.shippingProfileId),
                            label: p.title,
                          }))
                      ).map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : field === "description" ? (
                  <label htmlFor={id} className="block text-sm">
                    <span className="text-xs text-zinc-500">{FIELD_LABELS[field]}</span>
                    <textarea
                      id={id}
                      aria-label={ariaLabel}
                      rows={3}
                      value={String(value ?? "")}
                      onChange={(e) => onChange(field, e.target.value)}
                      className={`${inputCls} mt-1 resize-y py-2`}
                    />
                  </label>
                ) : (
                  <div className="text-sm">
                    <label htmlFor={id} className="block text-xs text-zinc-500">
                      {FIELD_LABELS[field]}
                    </label>
                    <input
                      id={id}
                      aria-label={ariaLabel}
                      type={field === "price" || field === "quantity" ? "number" : "text"}
                      step={field === "price" ? "0.01" : undefined}
                      min={field === "price" || field === "quantity" ? "0" : undefined}
                      maxLength={CHARACTER_LIMITS[field]}
                      value={String(value ?? "")}
                      onChange={(e) => onChange(field, e.target.value)}
                      className={`${inputCls} mt-1 h-9`}
                    />
                    <CharacterCounter field={field} value={String(value ?? "")} />
                  </div>
                )}
              </div>
              <button
                type="button"
                onClick={() => onApply(field)}
                className="h-9 shrink-0 rounded-full border border-black/10 px-3 text-xs font-medium transition-colors hover:bg-black/[.04] dark:border-white/15 dark:hover:bg-white/[.06]"
              >
                Apply {FIELD_LABELS[field].toLowerCase()} to all
              </button>
            </div>
          );
        })}
      </div>
    </section>
  );
}
