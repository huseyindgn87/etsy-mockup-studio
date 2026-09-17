"use client";

import { useId, useMemo } from "react";
import type { ListingFormValue } from "@/app/(app)/mockups/ListingForm";
import { VariationBlock, type VariationSubTab } from "@/app/(app)/mockups/VariationsSection";
import type { BulkFieldKey } from "@/lib/etsy/bulk-edit";
import { buildCombinationModel, cellKeyFor } from "@/lib/etsy/variation-combinations";
import { individualIndices, validateOfferings } from "@/lib/etsy/variation-offerings";
import type { TaxonomyProperty } from "@/lib/etsy/taxonomy";
import type { BulkListingDetail, ProcessingProfileOption } from "./types";

/** The inventory fields a variation listing edits per combination. */
export const VARIATION_FIELDS: ReadonlySet<BulkFieldKey> = new Set<BulkFieldKey>([
  "variations",
  "price",
  "quantity",
  "sku",
  "readinessStateId",
]);

const TAB_FOR_FIELD: Partial<Record<BulkFieldKey, VariationSubTab>> = {
  variations: "variations",
  price: "price",
  quantity: "quantity",
  sku: "sku",
  readinessStateId: "processing",
};

const PREVIEW_ROWS = 3;

const PHOTOS_NOTE =
  "Photos per variation aren't saved from bulk edit — Etsy assigns them with a separate call this screen doesn't make yet.";

/**
 * One listing's variation block in the bulk editor. Collapsed (the default)
 * it shows the first few combinations for the chosen field, fading out; the
 * full editor — the same block the listing editor uses — is only mounted once
 * the row is expanded.
 */
export default function VariationRowBlock({
  listing,
  field,
  form,
  status,
  expanded,
  onToggle,
  onChange,
  variationProperties,
  processingProfiles,
  currencyCode,
  showErrors,
}: {
  listing: BulkListingDetail;
  field: BulkFieldKey;
  form: ListingFormValue | null;
  status: "loading" | "missing" | "ready";
  expanded: boolean;
  onToggle: () => void;
  onChange: (partial: Partial<ListingFormValue>) => void;
  /** Null while the listing's category properties are loading. */
  variationProperties: TaxonomyProperty[] | null;
  processingProfiles: ProcessingProfileOption[];
  currencyCode: string | null;
  showErrors: boolean;
}) {
  const regionId = useId();
  const model = useMemo(() => buildCombinationModel(form?.variations ?? []), [form?.variations]);

  if (status === "loading" || !form) {
    return status === "missing" ? (
      <p className="text-xs text-zinc-500 dark:text-zinc-400">
        Etsy didn&apos;t return an inventory record for this listing, so its variations can&apos;t be edited here.
      </p>
    ) : (
      <p className="text-xs text-zinc-500">Loading variations…</p>
    );
  }

  const errors = showErrors ? validateOfferings(form, []) : [];
  const initialTab = errors[0]?.tab ?? TAB_FOR_FIELD[field] ?? "variations";

  const toggle = (
    <button
      type="button"
      aria-expanded={expanded}
      aria-controls={regionId}
      aria-label={`${expanded ? "Show less" : "Show all"} variations for ${listing.title}`}
      onClick={onToggle}
      className="mt-1 text-xs font-medium text-primary hover:underline"
    >
      {expanded ? "Show less" : "Show all"}
    </button>
  );

  if (expanded) {
    return (
      <div>
        <div id={regionId} className="space-y-3 rounded-lg border border-black/10 p-3 dark:border-white/15">
          <VariationBlock
            key={field}
            value={form}
            patch={onChange}
            variationProperties={variationProperties ?? []}
            propertiesLoading={variationProperties == null && listing.taxonomyId != null}
            propertiesError={null}
            processingProfiles={processingProfiles}
            currencyCode={currencyCode}
            showErrors={showErrors}
            initialTab={initialTab}
            photosNote={PHOTOS_NOTE}
            label={`Variation details for ${listing.title}`}
          />
        </div>
        {toggle}
      </div>
    );
  }

  const lines = previewLines(field, form, model, processingProfiles);
  return (
    <div>
      <div id={regionId} className="relative max-h-28 overflow-hidden rounded-lg border border-black/10 px-3 py-2 dark:border-white/15">
        {errors.length > 0 && <p className="text-xs font-medium text-red-600">{errors[0].message}</p>}
        <ul className="space-y-1 text-xs text-zinc-600 dark:text-zinc-300">
          {lines.map((line, i) => (
            <li key={i} className={line.hidden ? "text-zinc-400" : ""}>
              {line.text}
            </li>
          ))}
        </ul>
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-b from-transparent to-white dark:to-zinc-950"
        />
      </div>
      {toggle}
    </div>
  );
}

function previewLines(
  field: BulkFieldKey,
  form: ListingFormValue,
  model: ReturnType<typeof buildCombinationModel>,
  profiles: ProcessingProfileOption[],
): { text: string; hidden: boolean }[] {
  if (form.variations.length === 0) return [{ text: "No variations yet.", hidden: false }];
  if (field === "variations") {
    return [
      ...form.variations.map((v) => ({ text: `${v.name || "Variation"}: ${v.values.join(", ")}`, hidden: false })),
      { text: `${model.count} combination${model.count === 1 ? "" : "s"}`, hidden: false },
    ];
  }
  const key = field === "readinessStateId" ? "readiness" : (field as "price" | "quantity" | "sku");
  const indices = individualIndices(form, key);
  const base = key === "readiness" ? (form.readinessStateId == null ? "" : String(form.readinessStateId)) : form[key];
  return model.combinations.slice(0, PREVIEW_ROWS + 1).map((c) => {
    const own = indices.length > 0 ? (form.variationRows[key][cellKeyFor(indices, c.valueIds)] ?? "") : "";
    const raw = own.trim() !== "" ? own : base;
    const shown =
      key === "readiness" ? (profiles.find((p) => String(p.readinessStateId) === raw)?.displayLabel ?? (raw || "—")) : raw || "—";
    const hidden = form.variationRowEnabled[c.key] === false;
    return { text: `${c.values.join(" / ")} — ${shown}${hidden ? " (hidden)" : ""}`, hidden };
  });
}
