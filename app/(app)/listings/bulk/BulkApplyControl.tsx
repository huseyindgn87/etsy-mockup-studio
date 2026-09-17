"use client";

import { useState } from "react";
import {
  applyKindFor,
  MAX_TAG_LENGTH,
  WEIGHT_UNITS,
  DIMENSION_UNITS,
  type BulkFieldKey,
} from "@/lib/etsy/bulk-edit";
import {
  isUsableNumeric,
  type AmountUnit,
  type NumberOperation,
  type NumericInstruction,
  type SkuPosition,
} from "@/lib/etsy/bulk-operations";
import { TEXT_TRANSFORM_MODES, type TextTransformMode } from "@/lib/etsy/bulk-text";
import { WHEN_MADE_VALUES, WHO_MADE_OPTIONS, formatWhenMade } from "@/lib/etsy/listing-classification";
import { INPUT_CLS, labelFor, type AttributeChoices } from "./helpers";
import type { BulkOptions } from "./types";

/**
 * What an Apply press asks the editor to do to every *ticked* row. Resolving
 * it per row is the editor's job, not this control's: an operation depends on
 * each row's current value (or its variation grid), an append on its current
 * list, and an attribute value on the property that row's own category has.
 */
export type ApplyInstruction =
  | { kind: "transform"; mode: TextTransformMode; value: string; find: string }
  | { kind: "append"; value: string }
  | { kind: "attribute"; valueName: string; scaleName: string | null }
  | { kind: "set"; value: string }
  | { kind: "numeric"; instruction: NumericInstruction }
  | { kind: "sku"; position: SkuPosition; text: string }
  | { kind: "about"; whoMade: string; whenMade: string; isSupply: boolean }
  | { kind: "partners"; ids: number[] }
  | { kind: "weight"; weight: string; unit: string }
  | { kind: "size"; length: string; width: string; height: string; unit: string };

const NUMBER_OPERATIONS: { value: NumberOperation; label: string }[] = [
  { value: "set", label: "Set to" },
  { value: "increase", label: "Increase by" },
  { value: "decrease", label: "Decrease by" },
];

const SKU_POSITIONS: { value: SkuPosition; label: string }[] = [
  { value: "before", label: "Add before" },
  { value: "after", label: "Add after" },
  { value: "replace", label: "Replace" },
];

const buttonCls =
  "h-9 shrink-0 rounded-full border border-black/10 px-4 text-xs font-medium transition-colors hover:bg-black/[.04] disabled:cursor-not-allowed disabled:opacity-40 dark:border-white/15 dark:hover:bg-white/[.06]";

/**
 * The bar above the listing rows: one value and one Apply, written only to
 * rows whose checkbox is ticked — the secondary path next to editing each row.
 * Its shape depends on the field; Apply stays disabled until it holds a value
 * that can be applied. Fields edited per listing only (Media, Variations,
 * Personalization) get no bar.
 */
export default function BulkApplyControl({
  field,
  options,
  attributeChoices,
  targetedCount,
  currencySymbol = "$",
  onApply,
}: {
  field: BulkFieldKey;
  options: BulkOptions;
  /** Values (and scales) this attribute offers across the selection. */
  attributeChoices: AttributeChoices;
  targetedCount: number;
  currencySymbol?: string;
  onApply: (instruction: ApplyInstruction) => void;
}) {
  const kind = applyKindFor(field);
  const label = labelFor(field);

  const [mode, setMode] = useState<TextTransformMode>("before");
  const [text, setText] = useState("");
  const [find, setFind] = useState("");
  const [choice, setChoice] = useState("");
  const [scale, setScale] = useState("");
  const [operation, setOperation] = useState<NumberOperation>("set");
  const [unit, setUnit] = useState<AmountUnit>("amount");
  const [position, setPosition] = useState<SkuPosition>("before");
  const [whoMade, setWhoMade] = useState<string>(WHO_MADE_OPTIONS[0].value);
  const [whenMade, setWhenMade] = useState<string>(WHEN_MADE_VALUES[0]);
  const [isSupply, setIsSupply] = useState(false);
  const [partnerIds, setPartnerIds] = useState<number[]>([]);
  const [measureUnit, setMeasureUnit] = useState("");
  const [size, setSize] = useState({ length: "", width: "", height: "" });

  if (kind === "none") return null;

  const ariaLabel = `${label} to apply to all`;
  const numeric = field === "price" || field === "quantity";
  const attribute = field.startsWith("attr_");
  const scales = attribute ? attributeChoices.scales : [];
  const scaleValues = scales.find((s) => s.name === scale)?.values ?? [];

  const instruction = ((): ApplyInstruction | null => {
    if (numeric) {
      const numericInstruction = { operation, amount: text, unit };
      return isUsableNumeric(field, numericInstruction) ? { kind: "numeric", instruction: numericInstruction } : null;
    }
    if (field === "sku") return text ? { kind: "sku", position, text } : null;
    if (kind === "transform") {
      return (mode === "replace" ? find : text) ? { kind: "transform", mode, value: text, find } : null;
    }
    if (kind === "append") return text.trim() ? { kind: "append", value: text.trim() } : null;
    if (field === "about") return { kind: "about", whoMade, whenMade, isSupply };
    if (field === "productionPartners") return partnerIds.length > 0 ? { kind: "partners", ids: partnerIds } : null;
    if (field === "itemWeight") {
      return text.trim() && measureUnit ? { kind: "weight", weight: text.trim(), unit: measureUnit } : null;
    }
    if (field === "itemSize") {
      return measureUnit && (size.length || size.width || size.height)
        ? { kind: "size", ...size, unit: measureUnit }
        : null;
    }
    if (attribute) {
      if (!choice || (scales.length > 0 && !scale)) return null;
      return { kind: "attribute", valueName: choice, scaleName: scales.length > 0 ? scale : null };
    }
    return choice ? { kind: "set", value: choice } : null;
  })();

  function submit() {
    if (!instruction) return;
    onApply(instruction);
    if (instruction.kind === "append") setText("");
  }

  const selectChoicesList = attribute
    ? (scales.length > 0 ? scaleValues : attributeChoices.values).map((name) => ({ value: name, label: name }))
    : selectChoices(field, options);

  return (
    <section
      aria-label={`Apply to all selected — ${label}`}
      className="mt-4 rounded-xl border border-dashed border-black/15 bg-white p-4 dark:border-white/20 dark:bg-zinc-950"
    >
      <div className="flex items-center justify-between">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Apply to all selected</h2>
        <span className="text-xs text-zinc-500">
          {targetedCount} listing{targetedCount === 1 ? "" : "s"} ticked
        </span>
      </div>

      <div className="mt-2 flex flex-wrap items-end gap-2">
        {numeric && (
          <>
            <label className="text-sm">
              <span className="block text-xs text-zinc-500">Operation</span>
              <select
                aria-label={`${label} operation`}
                value={operation}
                onChange={(e) => {
                  const next = e.target.value as NumberOperation;
                  setOperation(next);
                  if (next === "set") setUnit("amount");
                }}
                className={`${INPUT_CLS} mt-1 h-9 w-36`}
              >
                {NUMBER_OPERATIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="w-32 text-sm">
              <span className="block text-xs text-zinc-500">Amount</span>
              <input
                type="text"
                inputMode="decimal"
                aria-label={ariaLabel}
                value={text}
                onChange={(e) => {
                  if (/^\d*(\.\d*)?$/.test(e.target.value)) setText(e.target.value);
                }}
                className={`${INPUT_CLS} mt-1 h-9`}
              />
            </label>
            {field === "price" && (
              <div role="group" aria-label="Amount unit" className="flex h-9 overflow-hidden rounded-lg border border-black/10 dark:border-white/15">
                {(
                  [
                    ["amount", currencySymbol, "Amount in money"],
                    ["percent", "%", "Amount as a percentage"],
                  ] as const
                ).map(([value, text, name]) => (
                  <button
                    key={value}
                    type="button"
                    aria-label={name}
                    aria-pressed={unit === value}
                    disabled={value === "percent" && operation === "set"}
                    onClick={() => setUnit(value)}
                    className={`w-9 text-sm disabled:cursor-not-allowed disabled:opacity-40 ${
                      unit === value ? "bg-black text-white dark:bg-white dark:text-black" : ""
                    }`}
                  >
                    {text}
                  </button>
                ))}
              </div>
            )}
          </>
        )}

        {field === "sku" && (
          <>
            <label className="text-sm">
              <span className="block text-xs text-zinc-500">Position</span>
              <select
                aria-label="SKU position"
                value={position}
                onChange={(e) => setPosition(e.target.value as SkuPosition)}
                className={`${INPUT_CLS} mt-1 h-9 w-36`}
              >
                {SKU_POSITIONS.map((p) => (
                  <option key={p.value} value={p.value}>
                    {p.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="min-w-[10rem] flex-1 text-sm">
              <span className="block text-xs text-zinc-500">Text</span>
              <input
                type="text"
                aria-label={ariaLabel}
                value={text}
                onChange={(e) => setText(e.target.value)}
                className={`${INPUT_CLS} mt-1 h-9`}
              />
            </label>
          </>
        )}

        {kind === "transform" && (
          <>
            <label className="text-sm">
              <span className="block text-xs text-zinc-500">Mode</span>
              <select
                aria-label={`${label} mode`}
                value={mode}
                onChange={(e) => setMode(e.target.value as TextTransformMode)}
                className={`${INPUT_CLS} mt-1 h-9 w-44`}
              >
                {TEXT_TRANSFORM_MODES.map((m) => (
                  <option key={m.value} value={m.value}>
                    {m.label}
                  </option>
                ))}
              </select>
            </label>
            {mode === "replace" && (
              <label className="min-w-[10rem] flex-1 text-sm">
                <span className="block text-xs text-zinc-500">Find</span>
                <input
                  type="text"
                  aria-label={`${label} find text`}
                  value={find}
                  onChange={(e) => setFind(e.target.value)}
                  className={`${INPUT_CLS} mt-1 h-9`}
                />
              </label>
            )}
            <label className="min-w-[10rem] flex-1 text-sm">
              <span className="block text-xs text-zinc-500">{mode === "replace" ? "Replace with" : "Text"}</span>
              <input
                type="text"
                aria-label={ariaLabel}
                value={text}
                onChange={(e) => setText(e.target.value)}
                className={`${INPUT_CLS} mt-1 h-9`}
              />
            </label>
          </>
        )}

        {kind === "append" && (
          <label className="min-w-[12rem] flex-1 text-sm">
            <span className="block text-xs text-zinc-500">{field === "tags" ? "Tag to add" : "Material to add"}</span>
            <input
              type="text"
              aria-label={ariaLabel}
              value={text}
              maxLength={field === "tags" ? MAX_TAG_LENGTH : undefined}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  submit();
                }
              }}
              className={`${INPUT_CLS} mt-1 h-9`}
            />
          </label>
        )}

        {field === "about" && (
          <>
            <label className="text-sm">
              <span className="block text-xs text-zinc-500">Who made it</span>
              <select
                aria-label="Who made it to apply to all"
                value={whoMade}
                onChange={(e) => setWhoMade(e.target.value)}
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
                aria-label="What is it to apply to all"
                value={isSupply ? "supply" : "product"}
                onChange={(e) => setIsSupply(e.target.value === "supply")}
                className={`${INPUT_CLS} mt-1 h-9 w-44`}
              >
                <option value="product">A finished product</option>
                <option value="supply">A supply or tool</option>
              </select>
            </label>
            <label className="text-sm">
              <span className="block text-xs text-zinc-500">When was it made</span>
              <select
                aria-label="When was it made to apply to all"
                value={whenMade}
                onChange={(e) => setWhenMade(e.target.value)}
                className={`${INPUT_CLS} mt-1 h-9 w-44`}
              >
                {WHEN_MADE_VALUES.map((v) => (
                  <option key={v} value={v}>
                    {formatWhenMade(v)}
                  </option>
                ))}
              </select>
            </label>
          </>
        )}

        {field === "productionPartners" && (
          <label className="min-w-[14rem] flex-1 text-sm">
            <span className="block text-xs text-zinc-500">Production partners</span>
            <select
              multiple
              aria-label={ariaLabel}
              value={partnerIds.map(String)}
              onChange={(e) => setPartnerIds([...e.target.selectedOptions].map((o) => Number(o.value)))}
              className={`${INPUT_CLS} mt-1 h-20 py-1`}
            >
              {options.productionPartners.map((p) => (
                <option key={p.productionPartnerId} value={p.productionPartnerId}>
                  {p.partnerName}
                  {p.location ? ` · ${p.location}` : ""}
                </option>
              ))}
            </select>
          </label>
        )}

        {field === "itemWeight" && (
          <>
            <label className="w-32 text-sm">
              <span className="block text-xs text-zinc-500">Weight</span>
              <input
                type="number"
                min="0"
                step="0.01"
                aria-label={ariaLabel}
                value={text}
                onChange={(e) => setText(e.target.value)}
                className={`${INPUT_CLS} mt-1 h-9`}
              />
            </label>
            <label className="w-28 text-sm">
              <span className="block text-xs text-zinc-500">Scale</span>
              <select
                aria-label="Item weight unit to apply to all"
                value={measureUnit}
                onChange={(e) => setMeasureUnit(e.target.value)}
                className={`${INPUT_CLS} mt-1 h-9`}
              >
                <option value="">Choose…</option>
                {WEIGHT_UNITS.map((u) => (
                  <option key={u} value={u}>
                    {u}
                  </option>
                ))}
              </select>
            </label>
          </>
        )}

        {field === "itemSize" && (
          <>
            {(["length", "width", "height"] as const).map((dimension) => (
              <label key={dimension} className="w-24 text-sm">
                <span className="block text-xs capitalize text-zinc-500">{dimension}</span>
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  aria-label={`Item ${dimension} to apply to all`}
                  value={size[dimension]}
                  onChange={(e) => setSize((prev) => ({ ...prev, [dimension]: e.target.value }))}
                  className={`${INPUT_CLS} mt-1 h-9`}
                />
              </label>
            ))}
            <label className="w-28 text-sm">
              <span className="block text-xs text-zinc-500">Scale</span>
              <select
                aria-label="Item size unit to apply to all"
                value={measureUnit}
                onChange={(e) => setMeasureUnit(e.target.value)}
                className={`${INPUT_CLS} mt-1 h-9`}
              >
                <option value="">Choose…</option>
                {DIMENSION_UNITS.map((u) => (
                  <option key={u} value={u}>
                    {u}
                  </option>
                ))}
              </select>
            </label>
          </>
        )}

        {kind === "select" && field !== "about" && field !== "productionPartners" && (
          <>
            <label className="min-w-[14rem] flex-1 text-sm">
              <span className="block text-xs text-zinc-500">{label}</span>
              <select
                aria-label={ariaLabel}
                value={choice}
                onChange={(e) => setChoice(e.target.value)}
                className={`${INPUT_CLS} mt-1 h-9`}
              >
                <option value="">Choose {label.toLowerCase()}</option>
                {selectChoicesList.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
            {scales.length > 0 && (
              <label className="w-40 text-sm">
                <span className="block text-xs text-zinc-500">Scale</span>
                <select
                  aria-label={`${label} scale to apply to all`}
                  value={scale}
                  onChange={(e) => {
                    setScale(e.target.value);
                    setChoice("");
                  }}
                  className={`${INPUT_CLS} mt-1 h-9`}
                >
                  <option value="">Choose scale</option>
                  {scales.map((s) => (
                    <option key={s.name} value={s.name}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </>
        )}

        <button type="button" onClick={submit} disabled={!instruction} className={buttonCls}>
          Apply
        </button>
      </div>

      {field === "tags" && (
        <p className="mt-2 text-xs text-zinc-500">
          Adds the tag to each ticked listing&apos;s existing tags — nothing is replaced or removed.
        </p>
      )}
    </section>
  );
}

/** The valid Etsy values one dropdown-backed field offers. */
function selectChoices(field: BulkFieldKey, options: BulkOptions): { value: string; label: string }[] {
  switch (field) {
    case "shopSectionId":
      return options.sections.map((s) => ({ value: String(s.shopSectionId), label: s.title }));
    case "shippingProfileId":
      return options.shippingProfiles.map((p) => ({ value: String(p.shippingProfileId), label: p.title }));
    case "readinessStateId":
      return options.processingProfiles.map((p) => ({
        value: String(p.readinessStateId),
        label: `${p.displayLabel || `${p.minProcessingDays}-${p.maxProcessingDays} days`} · ${
          p.readinessState === "made_to_order" ? "Made to order" : "Ready to ship"
        }`,
      }));
    case "returnPolicyId":
      return options.returnPolicies.map((p) => ({ value: String(p.returnPolicyId), label: p.label }));
    case "taxonomyId":
      return options.taxonomy.map((t) => ({ value: String(t.id), label: t.path }));
    default:
      return [];
  }
}
