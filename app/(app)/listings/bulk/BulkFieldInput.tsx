"use client";

import { useState } from "react";
import {
  CHARACTER_LIMITS,
  MAX_MATERIALS,
  MAX_MATERIAL_LENGTH,
  MAX_TAGS,
  MAX_TAG_LENGTH,
  WEIGHT_UNITS,
  DIMENSION_UNITS,
  isAttributeField,
  remainingCharacters,
  type BulkFieldKey,
} from "@/lib/etsy/bulk-edit";
import {
  WHEN_MADE_VALUES,
  WHO_MADE_OPTIONS,
  formatWhenMade,
  howItsMadeError,
} from "@/lib/etsy/listing-classification";
import {
  PERSONALIZATION_FIELD_TYPES,
  PERSONALIZATION_MAX_QUESTIONS,
  PERSONALIZATION_QUESTION_TEXT_MAX,
  type PersonalizationFieldType,
  type PersonalizationQuestionInput,
} from "@/lib/etsy/listing-personalization";
import { INPUT_CLS, ariaLabelFor, labelFor, propertyForListing, taxonomyPathFor } from "./helpers";
import type {
  AboutValue,
  AttributeValue,
  BulkListingDetail,
  BulkOptions,
  FieldValue,
  SizeValue,
  TaxonomyProperty,
  WeightValue,
} from "./types";

/** Inventory fields a variation listing can't take from a single row. */
export const INVENTORY_LOCKED = new Set<BulkFieldKey>(["price", "quantity", "sku"]);

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

/**
 * One listing's editable control for the field currently selected in the
 * sidebar. Every control names the listing it belongs to in its accessible
 * name, so a row's value can never be read or written through another row's.
 */
export default function BulkFieldInput({
  field,
  listing,
  value,
  options,
  onChange,
}: {
  field: BulkFieldKey;
  listing: BulkListingDetail;
  value: FieldValue;
  options: BulkOptions;
  onChange: (value: FieldValue) => void;
}) {
  const label = labelFor(field);
  const id = `${field}-${listing.listingId}`;
  const ariaLabel = ariaLabelFor(label, listing);

  if (INVENTORY_LOCKED.has(field) && listing.hasVariations) {
    return (
      <p className="text-xs text-zinc-500 dark:text-zinc-400">
        {label} varies by variation on this listing — edit it on the Variations card.
      </p>
    );
  }

  if (field === "tags" || field === "materials") {
    const isTags = field === "tags";
    return (
      <ChipsInput
        id={id}
        ariaLabel={ariaLabel}
        label={label}
        max={isTags ? MAX_TAGS : MAX_MATERIALS}
        maxLength={isTags ? MAX_TAG_LENGTH : MAX_MATERIAL_LENGTH}
        entries={Array.isArray(value) ? (value as string[]) : []}
        clearable={isTags}
        onChange={(entries) => onChange(entries)}
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
          className={`${INPUT_CLS} mt-1 resize-y py-2`}
        />
      </label>
    );
  }

  if (field === "about") {
    const about = value as AboutValue;
    const warning = howItsMadeError({
      whoMade: about.whoMade as "i_did" | "someone_else" | "collective",
      isSupply: about.isSupply,
      whenMade: about.whenMade,
      productionPartnerIds: about.productionPartnerIds,
    });
    return (
      <div className="space-y-2">
        <div className="flex flex-wrap gap-2">
          <label className="text-sm">
            <span className="block text-xs text-zinc-500">Who made it</span>
            <select
              aria-label={`Who made it for ${listing.title}`}
              value={about.whoMade}
              onChange={(e) => onChange({ ...about, whoMade: e.target.value })}
              className={`${INPUT_CLS} mt-1 h-9 w-48`}
            >
              {WHO_MADE_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          <label className="text-sm">
            <span className="block text-xs text-zinc-500">What is it</span>
            <select
              aria-label={`What is it for ${listing.title}`}
              value={about.isSupply ? "supply" : "product"}
              onChange={(e) => onChange({ ...about, isSupply: e.target.value === "supply" })}
              className={`${INPUT_CLS} mt-1 h-9 w-44`}
            >
              <option value="product">A finished product</option>
              <option value="supply">A supply or tool</option>
            </select>
          </label>
          <label className="text-sm">
            <span className="block text-xs text-zinc-500">When was it made</span>
            <select
              aria-label={`When was it made for ${listing.title}`}
              value={about.whenMade}
              onChange={(e) => onChange({ ...about, whenMade: e.target.value })}
              className={`${INPUT_CLS} mt-1 h-9 w-44`}
            >
              {WHEN_MADE_VALUES.map((v) => (
                <option key={v} value={v}>
                  {formatWhenMade(v)}
                </option>
              ))}
            </select>
          </label>
        </div>
        {warning && <p className="text-xs font-medium text-amber-600 dark:text-amber-500">{warning}</p>}
      </div>
    );
  }

  if (field === "productionPartners") {
    const selected = Array.isArray(value) ? (value as string[]) : [];
    return (
      <label htmlFor={id} className="block text-sm">
        <span className="text-xs text-zinc-500">{label}</span>
        {options.productionPartners.length === 0 ? (
          <p className="mt-1 text-xs text-zinc-500">
            This shop has no production partners yet — add one on Etsy, then reload.
          </p>
        ) : (
          <select
            id={id}
            aria-label={ariaLabel}
            multiple
            value={selected}
            onChange={(e) => onChange([...e.target.selectedOptions].map((o) => o.value))}
            className={`${INPUT_CLS} mt-1 h-20 py-1`}
          >
            {options.productionPartners.map((p) => (
              <option key={p.productionPartnerId} value={String(p.productionPartnerId)}>
                {p.partnerName}
                {p.location ? ` · ${p.location}` : ""}
              </option>
            ))}
          </select>
        )}
      </label>
    );
  }

  if (field === "personalization") {
    return (
      <PersonalizationRow
        listing={listing}
        questions={Array.isArray(value) ? (value as PersonalizationQuestionInput[]) : []}
        onChange={(questions) => onChange(questions)}
      />
    );
  }

  if (isAttributeField(field)) {
    const property = propertyForListing(field, listing, options);
    if (!property) {
      return (
        <p className="text-xs text-zinc-500 dark:text-zinc-400">
          {listing.taxonomyId == null
            ? "This listing has no category yet, so it has no attributes."
            : `This listing's category has no "${label}" attribute.`}
        </p>
      );
    }
    return (
      <AttributeRow
        id={id}
        ariaLabel={ariaLabel}
        listing={listing}
        property={property}
        attribute={value as AttributeValue}
        onChange={onChange}
      />
    );
  }

  if (field === "itemWeight") {
    const weight = value as WeightValue;
    return (
      <div className="flex flex-wrap items-end gap-2 text-sm">
        <label className="w-32">
          <span className="block text-xs text-zinc-500">Weight</span>
          <input
            id={id}
            aria-label={ariaLabel}
            type="number"
            min="0"
            step="0.01"
            value={weight.weight}
            onChange={(e) => onChange({ ...weight, weight: e.target.value })}
            className={`${INPUT_CLS} mt-1 h-9`}
          />
        </label>
        <label className="w-28">
          <span className="block text-xs text-zinc-500">Unit</span>
          <select
            aria-label={`Item weight unit for ${listing.title}`}
            value={weight.unit}
            onChange={(e) => onChange({ ...weight, unit: e.target.value })}
            className={`${INPUT_CLS} mt-1 h-9`}
          >
            <option value="">—</option>
            {WEIGHT_UNITS.map((u) => (
              <option key={u} value={u}>
                {u}
              </option>
            ))}
          </select>
        </label>
      </div>
    );
  }

  if (field === "itemSize") {
    const size = value as SizeValue;
    return (
      <div className="flex flex-wrap items-end gap-2 text-sm">
        {(["length", "width", "height"] as const).map((dimension) => (
          <label key={dimension} className="w-24">
            <span className="block text-xs capitalize text-zinc-500">{dimension}</span>
            <input
              aria-label={`Item ${dimension} for ${listing.title}`}
              type="number"
              min="0"
              step="0.01"
              value={size[dimension]}
              onChange={(e) => onChange({ ...size, [dimension]: e.target.value })}
              className={`${INPUT_CLS} mt-1 h-9`}
            />
          </label>
        ))}
        <label className="w-28">
          <span className="block text-xs text-zinc-500">Unit</span>
          <select
            aria-label={`Item size unit for ${listing.title}`}
            value={size.unit}
            onChange={(e) => onChange({ ...size, unit: e.target.value })}
            className={`${INPUT_CLS} mt-1 h-9`}
          >
            <option value="">—</option>
            {DIMENSION_UNITS.map((u) => (
              <option key={u} value={u}>
                {u}
              </option>
            ))}
          </select>
        </label>
      </div>
    );
  }

  if (
    field === "shopSectionId" ||
    field === "shippingProfileId" ||
    field === "returnPolicyId" ||
    field === "readinessStateId" ||
    field === "taxonomyId"
  ) {
    const choices = rowChoices(field, options);
    const path = field === "taxonomyId" ? taxonomyPathFor(listing, options) : "";
    return (
      <div className="text-sm">
        <label htmlFor={id} className="block text-xs text-zinc-500">
          {label}
        </label>
        <select
          id={id}
          aria-label={ariaLabel}
          value={String(value)}
          onChange={(e) => onChange(e.target.value)}
          className={`${INPUT_CLS} mt-1 h-9`}
        >
          <option value="">Keep as is</option>
          {choices.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        {field === "taxonomyId" && (
          <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">{path || "No category set"}</p>
        )}
        {field === "readinessStateId" && listing.readinessStateId == null && (
          <p className="mt-1 text-xs text-zinc-500">
            Etsy doesn&apos;t return this listing&apos;s current processing profile on a bulk read.
          </p>
        )}
      </div>
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
        className={`${INPUT_CLS} mt-1 h-9`}
      />
      <CharacterCounter field={field} value={String(value)} />
    </div>
  );
}

function rowChoices(field: BulkFieldKey, options: BulkOptions): { value: string; label: string }[] {
  switch (field) {
    case "shopSectionId":
      return options.sections.map((s) => ({ value: String(s.shopSectionId), label: s.title }));
    case "shippingProfileId":
      return options.shippingProfiles.map((p) => ({ value: String(p.shippingProfileId), label: p.title }));
    case "returnPolicyId":
      return options.returnPolicies.map((p) => ({ value: String(p.returnPolicyId), label: p.label }));
    case "readinessStateId":
      return options.processingProfiles.map((p) => ({
        value: String(p.readinessStateId),
        label: `${p.displayLabel || `${p.minProcessingDays}-${p.maxProcessingDays} days`} · ${
          p.readinessState === "made_to_order" ? "Made to order" : "Ready to ship"
        }`,
      }));
    case "taxonomyId":
      return options.taxonomy.map((t) => ({ value: String(t.id), label: t.path }));
    default:
      return [];
  }
}

/** Tag/material chips with Etsy's own count and per-entry length caps. */
function ChipsInput({
  id,
  ariaLabel,
  label,
  entries,
  max,
  maxLength,
  clearable = false,
  onChange,
}: {
  id: string;
  ariaLabel: string;
  label: string;
  entries: string[];
  max: number;
  maxLength: number;
  clearable?: boolean;
  onChange: (entries: string[]) => void;
}) {
  const [draft, setDraft] = useState("");

  function add() {
    const entry = draft.trim().slice(0, maxLength);
    setDraft("");
    if (!entry || entries.length >= max) return;
    if (entries.some((e) => e.toLowerCase() === entry.toLowerCase())) return;
    onChange([...entries, entry]);
  }

  return (
    <div className="text-sm">
      <span className="flex justify-between text-xs text-zinc-500">
        <span>{label}</span>
        <span className="flex items-center gap-2">
          {clearable && entries.length > 0 && (
            <button type="button" onClick={() => onChange([])} className="text-zinc-500 hover:text-red-600">
              Delete all
            </button>
          )}
          <span className="font-mono">
            {entries.length}/{max}
          </span>
        </span>
      </span>
      <div className="mt-1 flex flex-wrap items-center gap-1.5 rounded-lg border border-black/10 p-1.5 dark:border-white/15">
        {entries.map((entry) => (
          <span
            key={entry}
            className="flex items-center gap-1 rounded-full bg-black/[.06] px-2 py-0.5 text-xs dark:bg-white/10"
          >
            {entry}
            <button
              type="button"
              onClick={() => onChange(entries.filter((e) => e !== entry))}
              aria-label={`Remove ${entry}`}
              className="text-zinc-500 hover:text-red-600"
            >
              ×
            </button>
          </span>
        ))}
        {entries.length < max && (
          <input
            id={id}
            aria-label={ariaLabel}
            type="text"
            value={draft}
            maxLength={maxLength}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === ",") {
                e.preventDefault();
                add();
              }
            }}
            onBlur={add}
            placeholder={entries.length === 0 ? `Type a ${label.toLowerCase()}, press Enter…` : ""}
            className="min-w-[100px] flex-1 border-none bg-transparent px-1 py-0.5 text-sm outline-none"
          />
        )}
      </div>
      <span className="mt-0.5 block text-right font-mono text-[11px] text-zinc-500">
        {maxLength - draft.length} left in this entry
      </span>
    </div>
  );
}

/**
 * One listing's personalization questions. Etsy replaces the whole set on
 * write, so the editor always shows every question the listing has and sends
 * them back together.
 */
function PersonalizationRow({
  listing,
  questions,
  onChange,
}: {
  listing: BulkListingDetail;
  questions: PersonalizationQuestionInput[];
  onChange: (questions: PersonalizationQuestionInput[]) => void;
}) {
  function patchQuestion(index: number, partial: Partial<PersonalizationQuestionInput>) {
    onChange(questions.map((q, i) => (i === index ? { ...q, ...partial } : q)));
  }

  return (
    <div className="space-y-2">
      {questions.length === 0 && (
        <p className="text-xs text-zinc-500 dark:text-zinc-400">
          No personalization on this listing.
        </p>
      )}
      {questions.map((question, index) => (
        <div
          key={question.questionId ?? index}
          className="flex flex-wrap items-end gap-2 rounded-lg border border-black/10 p-2 dark:border-white/15"
        >
          <label className="min-w-[14rem] flex-1 text-sm">
            <span className="block text-xs text-zinc-500">Label shown to the buyer</span>
            <input
              type="text"
              aria-label={`Personalization ${index + 1} for ${listing.title}`}
              value={question.questionText}
              maxLength={PERSONALIZATION_QUESTION_TEXT_MAX}
              onChange={(e) => patchQuestion(index, { questionText: e.target.value })}
              className={`${INPUT_CLS} mt-1 h-9`}
            />
          </label>
          <label className="text-sm">
            <span className="block text-xs text-zinc-500">Field type</span>
            <select
              aria-label={`Personalization ${index + 1} type for ${listing.title}`}
              value={question.fieldType}
              onChange={(e) =>
                patchQuestion(index, { fieldType: e.target.value as PersonalizationFieldType })
              }
              className={`${INPUT_CLS} mt-1 h-9 w-40`}
            >
              {PERSONALIZATION_FIELD_TYPES.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </select>
          </label>
          <label className="flex h-9 items-center gap-1.5 text-sm">
            <input
              type="checkbox"
              aria-label={`Personalization ${index + 1} required for ${listing.title}`}
              checked={question.required}
              onChange={(e) => patchQuestion(index, { required: e.target.checked })}
              className="accent-primary"
            />
            Required
          </label>
          <button
            type="button"
            onClick={() => onChange(questions.filter((_, i) => i !== index))}
            className="h-9 text-xs font-medium text-red-600 hover:underline"
          >
            Remove
          </button>
        </div>
      ))}
      {questions.length < PERSONALIZATION_MAX_QUESTIONS && (
        <button
          type="button"
          onClick={() =>
            onChange([
              ...questions,
              {
                questionText: "",
                instructions: "",
                required: false,
                fieldType: "text_input",
                maxAllowedCharacters: 50,
                maxAllowedFiles: 1,
                options: [],
              },
            ])
          }
          className="h-8 rounded-full border border-black/10 px-3 text-xs font-medium hover:bg-black/[.04] dark:border-white/15 dark:hover:bg-white/[.06]"
        >
          + Add personalization
        </button>
      )}
    </div>
  );
}

/** One Optional attribute: a value dropdown, paired with a Scale dropdown when the property has scales. */
function AttributeRow({
  id,
  ariaLabel,
  listing,
  property,
  attribute,
  onChange,
}: {
  id: string;
  ariaLabel: string;
  listing: BulkListingDetail;
  property: TaxonomyProperty;
  attribute: AttributeValue;
  onChange: (value: FieldValue) => void;
}) {
  const [chosenScale, setChosenScale] = useState<number | null>(null);
  const scaleId = chosenScale ?? attribute.scaleId ?? property.scales[0]?.scaleId ?? null;
  const values = property.possibleValues.filter(
    (v) => v.valueId != null && (property.scales.length === 0 || v.scaleId === scaleId),
  );
  return (
    <div className="flex flex-wrap items-end gap-2 text-sm">
      <label htmlFor={id} className="block min-w-[12rem] flex-1">
        <span className="text-xs text-zinc-500">{property.displayName}</span>
        <select
          id={id}
          aria-label={ariaLabel}
          value={attribute.values[0] ?? ""}
          onChange={(e) => {
            const picked = values.find((v) => v.name === e.target.value);
            onChange(
              picked && picked.valueId != null
                ? { propertyId: property.propertyId, valueIds: [picked.valueId], values: [picked.name], scaleId: picked.scaleId }
                : { propertyId: property.propertyId, valueIds: [], values: [], scaleId: null },
            );
          }}
          className={`${INPUT_CLS} mt-1 h-9`}
        >
          <option value="">Keep as is</option>
          {values.map((v) => (
            <option key={v.valueId} value={v.name}>
              {v.name}
            </option>
          ))}
        </select>
      </label>
      {property.scales.length > 0 && (
        <label className="block w-40">
          <span className="text-xs text-zinc-500">Scale</span>
          <select
            aria-label={`${property.displayName} scale for ${listing.title}`}
            value={scaleId ?? ""}
            onChange={(e) => {
              setChosenScale(Number(e.target.value));
              onChange({ propertyId: property.propertyId, valueIds: [], values: [], scaleId: null });
            }}
            className={`${INPUT_CLS} mt-1 h-9`}
          >
            {property.scales.map((scale) => (
              <option key={scale.scaleId} value={scale.scaleId}>
                {scale.displayName}
              </option>
            ))}
          </select>
        </label>
      )}
    </div>
  );
}
