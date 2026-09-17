"use client";

import { useId, useMemo, useState, type KeyboardEvent } from "react";
import { EditorSectionCard } from "./editor-sections";
import type { ListingFormValue } from "./ListingForm";
import type { TaxonomyNode, TaxonomyProperty } from "@/lib/etsy/taxonomy";
import { cascadeLevels, indexTaxonomy, selectCascadeLevel } from "@/lib/etsy/taxonomy-cascade";
import {
  addColumnValue,
  clearedVariationState,
  combinationDataLoss,
  createCombinationCache,
  describeDataLoss,
  moveColumnValue,
  nextCustomPropertyId,
  removeColumn,
  removeColumnValue,
  renameColumn,
  setColumnProperty,
  setColumnScale,
  type CombinationModel,
  type VariationDimension,
  type VariationState,
} from "@/lib/etsy/variation-combinations";
import {
  MAX_OPTIONS_PER_VARIATION,
  MAX_VARIATIONS,
  maxCombinationsFor,
} from "@/lib/etsy/variation-limits";

export const VARIATION_SUB_TABS = [
  { key: "variations", label: "Variations" },
  { key: "price", label: "Price" },
  { key: "quantity", label: "Quantity" },
  { key: "sku", label: "SKU" },
  { key: "visibility", label: "Visibility" },
  { key: "photos", label: "Photos" },
  { key: "processing", label: "Processing" },
] as const;

type SubTab = (typeof VARIATION_SUB_TABS)[number]["key"];

const COLUMN_ORDINALS = ["first", "second", "third"] as const;

const selectCls =
  "h-9 w-full rounded-lg border border-black/10 bg-white px-2 text-sm outline-none focus:border-primary disabled:cursor-not-allowed disabled:opacity-50 dark:border-white/15 dark:bg-zinc-950";

interface PendingChange {
  message: string;
  partial: Partial<ListingFormValue>;
}

function variationPartial(state: VariationState): Partial<ListingFormValue> {
  return {
    variations: state.variations,
    variationToggles: state.variationToggles,
    variationRows: state.variationRows,
    variationRowEnabled: state.variationRowEnabled,
  };
}

/**
 * The Variations section: cascading category dropdowns, then an inner tab bar
 * (Variations, Price, … Processing) over one combination model shared by
 * every tab. The Variations tab edits up to three property columns.
 */
export default function VariationsSection({
  value,
  patch,
  taxonomyTree,
  taxonomyError,
  variationProperties,
  propertiesLoading,
  propertiesError,
}: {
  value: ListingFormValue;
  patch: (partial: Partial<ListingFormValue>) => void;
  taxonomyTree: TaxonomyNode[] | null;
  taxonomyError: string | null;
  variationProperties: TaxonomyProperty[];
  propertiesLoading: boolean;
  propertiesError: string | null;
}) {
  const [tab, setTab] = useState<SubTab>("variations");
  const [expanded, setExpanded] = useState(true);
  const [pending, setPending] = useState<PendingChange | null>(null);
  const [combinationsFor] = useState(createCombinationCache);
  const model = combinationsFor(value.variations);
  const bodyId = useId();

  /** Applies a structural edit, asking first when it would delete combination data. */
  function commit(next: VariationState, what: string, extra: Partial<ListingFormValue> = {}) {
    const partial = { ...variationPartial(next), ...extra };
    const loss = combinationDataLoss(value, next);
    if (loss.combinations > 0) {
      setPending({ message: `${what} deletes ${describeDataLoss(loss)}.`, partial });
    } else {
      patch(partial);
    }
  }

  function onTabKey(e: KeyboardEvent<HTMLButtonElement>, index: number) {
    const last = VARIATION_SUB_TABS.length - 1;
    const target =
      e.key === "ArrowRight" ? (index === last ? 0 : index + 1)
      : e.key === "ArrowLeft" ? (index === 0 ? last : index - 1)
      : e.key === "Home" ? 0
      : e.key === "End" ? last
      : null;
    if (target == null) return;
    e.preventDefault();
    setTab(VARIATION_SUB_TABS[target].key);
    e.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[target]?.focus();
  }

  return (
    <EditorSectionCard section="variations" className="space-y-4">
      {expanded && (
        <TaxonomyCascade
          tree={taxonomyTree}
          error={taxonomyError}
          taxonomyId={value.taxonomyId}
          taxonomyPath={value.taxonomyPath}
          onSelect={(taxonomy) =>
            commit(clearedVariationState(), "Changing the category", { ...taxonomy, properties: {} })
          }
        />
      )}

      <div className="flex items-end justify-between gap-3 border-b border-black/10 dark:border-white/15">
        <div role="tablist" aria-label="Variation details" className="-mb-px flex overflow-x-auto">
          {VARIATION_SUB_TABS.map((t, i) => (
            <button
              key={t.key}
              type="button"
              role="tab"
              id={`${bodyId}-tab-${t.key}`}
              aria-selected={tab === t.key}
              aria-controls={`${bodyId}-panel`}
              tabIndex={tab === t.key ? 0 : -1}
              onClick={() => {
                setTab(t.key);
                setExpanded(true);
              }}
              onKeyDown={(e) => onTabKey(e, i)}
              className={`shrink-0 border-b-2 px-3 py-2 text-sm ${
                tab === t.key
                  ? "border-primary font-medium text-zinc-900 dark:text-zinc-50"
                  : "border-transparent text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={`${bodyId}-panel`}
          onClick={() => setExpanded((x) => !x)}
          className="mb-1.5 shrink-0 text-sm font-medium text-primary hover:underline"
        >
          {expanded ? "Show less" : "Show more"}
        </button>
      </div>

      {expanded && (
        <div
          role="tabpanel"
          id={`${bodyId}-panel`}
          aria-labelledby={`${bodyId}-tab-${tab}`}
        >
          {tab === "variations" ? (
            <VariationColumns
              value={value}
              model={model}
              variationProperties={variationProperties}
              propertiesLoading={propertiesLoading}
              propertiesError={propertiesError}
              commit={commit}
              patch={patch}
            />
          ) : (
            <SubTabPlaceholder
              label={VARIATION_SUB_TABS.find((t) => t.key === tab)!.label}
              model={model}
            />
          )}
        </div>
      )}

      {pending && (
        <ConfirmDataLoss
          message={pending.message}
          onCancel={() => setPending(null)}
          onConfirm={() => {
            patch(pending.partial);
            setPending(null);
          }}
        />
      )}
    </EditorSectionCard>
  );
}

function TaxonomyCascade({
  tree,
  error,
  taxonomyId,
  taxonomyPath,
  onSelect,
}: {
  tree: TaxonomyNode[] | null;
  error: string | null;
  taxonomyId: number | null;
  taxonomyPath: string;
  onSelect: (taxonomy: { taxonomyId: number | null; taxonomyPath: string }) => void;
}) {
  const index = useMemo(() => indexTaxonomy(tree ?? []), [tree]);
  const levels = useMemo(() => cascadeLevels(tree ?? [], index, taxonomyId), [tree, index, taxonomyId]);
  const missing = tree != null && taxonomyId != null && !index.has(taxonomyId);

  return (
    <div className="space-y-2">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {levels.map((level, i) => (
          <label key={i} className="block text-sm">
            <span className="text-xs text-zinc-500">{level.label}</span>
            <select
              value={level.selectedId ?? ""}
              disabled={tree == null || level.disabled}
              onChange={(e) =>
                onSelect(selectCascadeLevel(index, taxonomyId, i, e.target.value ? Number(e.target.value) : null))
              }
              className={`${selectCls} mt-1`}
            >
              <option value="">{tree == null && !error ? "Loading…" : `Choose ${level.label.toLowerCase()}`}</option>
              {level.options.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </select>
          </label>
        ))}
      </div>
      {error && <p className="text-xs text-red-600">{error}</p>}
      {(missing || (error && taxonomyPath)) && (
        <p className="text-xs text-zinc-500">Current category: {taxonomyPath}</p>
      )}
    </div>
  );
}

function VariationColumns({
  value,
  model,
  variationProperties,
  propertiesLoading,
  propertiesError,
  commit,
  patch,
}: {
  value: ListingFormValue;
  model: CombinationModel;
  variationProperties: TaxonomyProperty[];
  propertiesLoading: boolean;
  propertiesError: string | null;
  commit: (next: VariationState, what: string) => void;
  patch: (partial: Partial<ListingFormValue>) => void;
}) {
  const [drag, setDrag] = useState<{ column: number; index: number } | null>(null);
  const variations = value.variations;

  const oversized = variations.find((v) => v.values.length > MAX_OPTIONS_PER_VARIATION);
  const boundToAll = (["price", "quantity", "sku", "readiness"] as const).some((k) => {
    const t = value.variationToggles[k];
    return t.enabled && variations.length > 0 && new Set(t.appliesTo).size >= variations.length;
  });
  const cap = maxCombinationsFor(variations.length, boundToAll);
  const violation = oversized
    ? `"${oversized.name}" has ${oversized.values.length} options — Etsy allows at most ${MAX_OPTIONS_PER_VARIATION} per variation type.`
    : model.count > cap
      ? `${model.count} combinations exceeds Etsy's limit of ${cap}.`
      : null;

  return (
    <div className="space-y-3">
      {value.taxonomyId == null && (
        <p className="text-xs text-zinc-500">Choose a category above to see the variations Etsy offers for it.</p>
      )}
      {propertiesLoading && <p className="text-xs text-zinc-500">Loading variation options…</p>}
      {propertiesError && <p className="text-xs text-red-600">{propertiesError}</p>}

      <div className="grid gap-3 md:grid-cols-3">
        {Array.from({ length: MAX_VARIATIONS }, (_, column) => (
          <VariationColumn
            key={column}
            column={column}
            variations={variations}
            variationProperties={variationProperties}
            drag={drag}
            setDrag={setDrag}
            onChoose={(choice) => {
              const current = variations[column];
              const what = current ? `Replacing “${current.name || "this variation"}”` : "This change";
              if (choice === "") {
                commit(removeColumn(value, column), `Removing “${current?.name || "this variation"}”`);
              } else if (choice === "custom") {
                commit(
                  setColumnProperty(value, column, {
                    propertyId: nextCustomPropertyId(variations, column < variations.length ? column : null),
                    name: "",
                    isCustom: true,
                  }),
                  what,
                );
              } else {
                const property = variationProperties.find((p) => `p${p.propertyId}` === choice);
                if (!property) return;
                commit(
                  setColumnProperty(value, column, {
                    propertyId: property.propertyId,
                    name: property.displayName,
                    isCustom: false,
                    scaleId: property.scales[0]?.scaleId ?? null,
                  }),
                  what,
                );
              }
            }}
            onClear={() =>
              commit(removeColumn(value, column), `Removing “${variations[column]?.name || "this variation"}”`)
            }
            onRename={(name) => patch(variationPartial(renameColumn(value, column, name)))}
            onScale={(scaleId) =>
              commit(setColumnScale(value, column, scaleId), `Changing the scale of “${variations[column].name}”`)
            }
            onAdd={(input) => patch(variationPartial(addColumnValue(value, column, input)))}
            onRemove={(i) =>
              commit(removeColumnValue(value, column, i), `Removing “${variations[column].values[i]}”`)
            }
            onMove={(from, to) => patch(variationPartial(moveColumnValue(value, column, from, to)))}
          />
        ))}
      </div>

      {variations.length > 0 && (
        <p className={`text-xs ${model.count > cap ? "font-medium text-red-600" : "text-zinc-500"}`}>
          {model.count} {model.count === 1 ? "combination" : "combinations"} (max {cap}).
        </p>
      )}
      {violation && <p className="text-xs font-medium text-red-600">{violation}</p>}
    </div>
  );
}

function VariationColumn({
  column,
  variations,
  variationProperties,
  drag,
  setDrag,
  onChoose,
  onClear,
  onRename,
  onScale,
  onAdd,
  onRemove,
  onMove,
}: {
  column: number;
  variations: VariationDimension[];
  variationProperties: TaxonomyProperty[];
  drag: { column: number; index: number } | null;
  setDrag: (drag: { column: number; index: number } | null) => void;
  onChoose: (choice: string) => void;
  onClear: () => void;
  onRename: (name: string) => void;
  onScale: (scaleId: number | null) => void;
  onAdd: (input: { name: string; valueId?: number | null }) => void;
  onRemove: (index: number) => void;
  onMove: (from: number, to: number) => void;
}) {
  const variation = variations[column];
  const enabled = column <= variations.length;
  const ordinal = COLUMN_ORDINALS[column];
  const property = variation && !variation.isCustom
    ? variationProperties.find((p) => p.propertyId === variation.propertyId)
    : undefined;
  const takenElsewhere = new Set(
    variations.filter((v, i) => i !== column && !v.isCustom).map((v) => v.propertyId),
  );
  const offered = variationProperties.filter((p) => !takenElsewhere.has(p.propertyId));
  const selectValue = !variation ? "" : variation.isCustom ? "current-custom" : `p${variation.propertyId}`;
  const label = variation?.name || (variation?.isCustom ? "Custom variation" : `Variation ${column + 1}`);

  return (
    <div
      data-variation-column={column}
      className="flex min-h-48 flex-col rounded-lg border border-black/10 dark:border-white/15"
    >
      <div className="flex items-center gap-1.5 border-b border-black/10 p-2 dark:border-white/15">
        <select
          aria-label={`${ordinal[0].toUpperCase()}${ordinal.slice(1)} variation`}
          value={selectValue}
          disabled={!enabled}
          onChange={(e) => onChoose(e.target.value)}
          className={selectCls}
        >
          <option value="">Choose Variation</option>
          {variation?.isCustom && <option value="current-custom">{label}</option>}
          {variation && !variation.isCustom && !property && (
            <option value={`p${variation.propertyId}`}>{variation.name}</option>
          )}
          {offered.map((p) => (
            <option key={p.propertyId} value={`p${p.propertyId}`}>
              {p.displayName}
            </option>
          ))}
          <option value="custom">Create your own…</option>
        </select>
        <button
          type="button"
          onClick={onClear}
          disabled={!variation}
          aria-label={`Delete ${ordinal} variation`}
          className="shrink-0 rounded p-1.5 text-zinc-500 hover:bg-red-50 hover:text-red-600 disabled:cursor-not-allowed disabled:opacity-40 dark:hover:bg-red-950/30"
        >
          <svg aria-hidden="true" viewBox="0 0 20 20" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.6">
            <path d="M4 6h12M8 6V4h4v2m-6 0 1 10h6l1-10" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </div>

      <div className="flex flex-1 flex-col gap-2 p-2">
        {!variation ? (
          <p className="m-auto text-center text-xs text-zinc-500">
            {column === 2 ? "No third variation" : enabled ? "Choose a variation to list its options." : "Choose the first variation first."}
          </p>
        ) : (
          <>
            {variation.isCustom && (
              <input
                type="text"
                aria-label={`${ordinal[0].toUpperCase()}${ordinal.slice(1)} variation name`}
                value={variation.name}
                onChange={(e) => onRename(e.target.value)}
                placeholder="Name this variation, e.g. Paper type"
                className={selectCls}
              />
            )}
            {property && property.scales.length > 0 && (
              <select
                aria-label={`${variation.name} scale`}
                value={variation.scaleId ?? property.scales[0].scaleId}
                onChange={(e) => onScale(Number(e.target.value))}
                className={selectCls}
              >
                {property.scales.map((s) => (
                  <option key={s.scaleId} value={s.scaleId}>
                    {s.displayName}
                  </option>
                ))}
              </select>
            )}

            <ol aria-label={`${label} options`} className="space-y-1">
              {variation.values.map((name, i) => (
                <li
                  key={variation.valueIds[i]}
                  draggable
                  onDragStart={(e) => {
                    e.dataTransfer?.setData("text/plain", name);
                    if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
                    setDrag({ column, index: i });
                  }}
                  onDragOver={(e) => {
                    if (drag?.column === column) e.preventDefault();
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    if (drag?.column === column) onMove(drag.index, i);
                    setDrag(null);
                  }}
                  onDragEnd={() => setDrag(null)}
                  className={`flex items-center gap-2 rounded-md border border-black/10 px-2 py-1.5 text-sm dark:border-white/15 ${
                    drag?.column === column && drag.index === i ? "opacity-50" : ""
                  }`}
                >
                  <button
                    type="button"
                    aria-label={`Move ${name}`}
                    title="Drag, or use the arrow keys, to reorder"
                    onKeyDown={(e) => {
                      if (e.key === "ArrowUp" && i > 0) {
                        e.preventDefault();
                        onMove(i, i - 1);
                      } else if (e.key === "ArrowDown" && i < variation.values.length - 1) {
                        e.preventDefault();
                        onMove(i, i + 1);
                      }
                    }}
                    className="cursor-grab select-none text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"
                  >
                    ⠿
                  </button>
                  <span className="min-w-0 flex-1 truncate">{name}</span>
                  <button
                    type="button"
                    onClick={() => onRemove(i)}
                    aria-label={`Remove ${name}`}
                    className="shrink-0 text-zinc-400 hover:text-red-600"
                  >
                    ×
                  </button>
                </li>
              ))}
            </ol>

            <AddValue
              label={label}
              property={property}
              variation={variation}
              onAdd={onAdd}
            />
          </>
        )}
      </div>
    </div>
  );
}

function AddValue({
  label,
  property,
  variation,
  onAdd,
}: {
  label: string;
  property: TaxonomyProperty | undefined;
  variation: VariationDimension;
  onAdd: (input: { name: string; valueId?: number | null }) => void;
}) {
  const [draft, setDraft] = useState("");
  const listId = useId();
  const full = variation.values.length >= MAX_OPTIONS_PER_VARIATION;
  const suggestions = useMemo(() => {
    if (!property) return [];
    const scaleId = variation.scaleId ?? property.scales[0]?.scaleId ?? null;
    const taken = new Set(variation.values.map((v) => v.toLowerCase()));
    return property.possibleValues.filter(
      (pv) => (property.scales.length === 0 || pv.scaleId === scaleId) && !taken.has(pv.name.toLowerCase()),
    );
  }, [property, variation.scaleId, variation.values]);

  function add() {
    const name = draft.trim();
    if (!name) return;
    const match = property?.possibleValues.find((pv) => pv.name.toLowerCase() === name.toLowerCase());
    onAdd(match ? { name: match.name, valueId: match.valueId } : { name });
    setDraft("");
  }

  return (
    <div className="mt-auto flex gap-1.5">
      <input
        type="text"
        aria-label={`New ${label} option`}
        list={suggestions.length > 0 ? listId : undefined}
        value={draft}
        disabled={full}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            add();
          }
        }}
        placeholder={full ? `${MAX_OPTIONS_PER_VARIATION} options max` : "Add an option…"}
        className={selectCls}
      />
      {suggestions.length > 0 && (
        <datalist id={listId}>
          {suggestions.map((pv) => (
            <option key={`${pv.valueId ?? pv.name}`} value={pv.name} />
          ))}
        </datalist>
      )}
      <button
        type="button"
        onClick={add}
        disabled={full || !draft.trim()}
        aria-label={`Add ${label} option`}
        className="h-9 shrink-0 rounded-lg border border-black/10 px-3 text-sm font-medium hover:bg-black/[.04] disabled:cursor-not-allowed disabled:opacity-40 dark:border-white/15 dark:hover:bg-white/[.06]"
      >
        Add
      </button>
    </div>
  );
}

function SubTabPlaceholder({ label, model }: { label: string; model: CombinationModel }) {
  return (
    <div className="flex items-center justify-center rounded-lg border border-dashed border-black/20 py-10 text-center dark:border-white/25">
      <p className="text-sm text-zinc-500">
        {label} per combination isn&apos;t editable here yet
        {model.count > 0 ? ` (${model.count} ${model.count === 1 ? "combination" : "combinations"})` : ""}.
      </p>
    </div>
  );
}

function ConfirmDataLoss({
  message,
  onConfirm,
  onCancel,
}: {
  message: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const titleId = useId();
  const messageId = useId();
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={messageId}
        onKeyDown={(e) => {
          if (e.key === "Escape") onCancel();
        }}
        className="w-full max-w-sm space-y-3 rounded-xl border border-black/10 bg-white p-4 shadow-xl dark:border-white/15 dark:bg-zinc-950"
      >
        <h4 id={titleId} className="text-base font-bold text-zinc-900 dark:text-zinc-50">
          Delete combination data?
        </h4>
        <p id={messageId} className="text-sm text-zinc-600 dark:text-zinc-300">
          {message} This can&apos;t be undone.
        </p>
        <div className="flex justify-end gap-2">
          <button
            type="button"
            autoFocus
            onClick={onCancel}
            className="h-8 rounded-lg border border-black/10 px-3 text-sm hover:bg-black/[.04] dark:border-white/15 dark:hover:bg-white/[.06]"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="h-8 rounded-lg bg-red-600 px-3 text-sm font-medium text-white hover:bg-red-700"
          >
            Delete
          </button>
        </div>
      </div>
    </div>
  );
}
