"use client";

import { useId, useMemo, useState, type KeyboardEvent, type ReactNode } from "react";
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
  renameColumnValue,
  setColumnProperty,
  setColumnScale,
  type CombinationModel,
  type VariationDimension,
  type VariationState,
} from "@/lib/etsy/variation-combinations";
import {
  OFFERING_TABS,
  photoPropertyIndex,
  prunedVariationPhotos,
  validateOfferings,
  type OfferingTab,
  type ProcessingProfile,
} from "@/lib/etsy/variation-offerings";
import {
  FieldTabPanel,
  PhotosPanel,
  VisibilityPanel,
  type OfferingJump,
  type VariationPhotoOption,
} from "./VariationOfferingTabs";
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

export type { VariationPhotoOption };

const COLUMN_ORDINALS = ["first", "second", "third"] as const;

const NO_PHOTOS: readonly VariationPhotoOption[] = [];

const selectCls =
  "h-9 w-full rounded-lg border border-black/10 bg-white px-2 text-sm outline-none focus:border-primary disabled:cursor-not-allowed disabled:opacity-50 dark:border-white/15 dark:bg-zinc-950";

interface PendingChange {
  message: string;
  partial: Partial<ListingFormValue>;
}

function variationPartial(state: VariationState, photos: Record<string, string>): Partial<ListingFormValue> {
  return {
    variations: state.variations,
    variationToggles: state.variationToggles,
    variationRows: state.variationRows,
    variationRowEnabled: state.variationRowEnabled,
    variationPhotos: prunedVariationPhotos(state.variations, photos),
  };
}

/**
 * The Variations section: cascading category dropdowns above the variation
 * block — an inner tab bar (Variations, Price, … Processing) over one
 * combination model shared by every tab. The Variations tab edits up to three
 * property columns; the others edit each combination's price, quantity, SKU,
 * visibility, photo and processing profile.
 */
export default function VariationsSection({
  value,
  patch,
  taxonomyTree,
  taxonomyError,
  ...block
}: Omit<VariationBlockProps, "collapsible" | "renderAbove" | "initialTab" | "label" | "photosNote"> & {
  taxonomyTree: TaxonomyNode[] | null;
  taxonomyError: string | null;
}) {
  return (
    <EditorSectionCard section="variations" className="space-y-4">
      <VariationBlock
        value={value}
        patch={patch}
        {...block}
        collapsible
        renderAbove={({ expanded, commit }) =>
          expanded && (
            <TaxonomyCascade
              tree={taxonomyTree}
              error={taxonomyError}
              taxonomyId={value.taxonomyId}
              taxonomyPath={value.taxonomyPath}
              onSelect={(taxonomy) =>
                commit(clearedVariationState(), "Changing the category", { ...taxonomy, properties: {} })
              }
            />
          )
        }
      />
    </EditorSectionCard>
  );
}

export type VariationSubTab = SubTab;

type CommitVariation = (
  next: VariationState,
  what: string,
  extra?: Partial<ListingFormValue>,
  options?: { ask?: boolean },
) => void;

export interface VariationBlockProps {
  value: ListingFormValue;
  patch: (partial: Partial<ListingFormValue>) => void;
  variationProperties: TaxonomyProperty[];
  propertiesLoading: boolean;
  propertiesError: string | null;
  processingProfiles?: readonly ProcessingProfile[] | null;
  /** The listing's photo grid, in upload order. */
  photoSlots?: readonly VariationPhotoOption[];
  currencyCode?: string | null;
  /** Mark rows and tabs with errors (after a refused Publish). */
  showErrors?: boolean;
  /** Each change opens the tab and row of the first error. */
  errorJump?: number;
  /** The sub-tab shown first. */
  initialTab?: SubTab;
  /** Adds the Show less / Show more toggle beside the tab bar. */
  collapsible?: boolean;
  /** Rendered above the tab bar, e.g. the category cascade. */
  renderAbove?: (api: { expanded: boolean; commit: CommitVariation }) => ReactNode;
  /** Shown on the Photos tab instead of its controls, where photos can't be assigned. */
  photosNote?: string;
  /** The tab bar's accessible name. */
  label?: string;
}

/**
 * The variation editor itself — tab bar, panels and the confirm-before-delete
 * dialog — shared by the listing editor and every row of the bulk editor.
 */
export function VariationBlock({
  value,
  patch,
  variationProperties,
  propertiesLoading,
  propertiesError,
  processingProfiles = null,
  photoSlots = NO_PHOTOS,
  currencyCode = null,
  showErrors = false,
  errorJump = 0,
  initialTab = "variations",
  collapsible = false,
  renderAbove,
  photosNote,
  label = "Variation details",
}: VariationBlockProps) {
  const [tab, setTab] = useState<SubTab>(initialTab);
  const [expanded, setExpanded] = useState(true);
  const [pending, setPending] = useState<PendingChange | null>(null);
  const [combinationsFor] = useState(createCombinationCache);
  const model = combinationsFor(value.variations);
  const bodyId = useId();

  const photoSlotIds = useMemo(() => photoSlots.map((s) => s.slotId), [photoSlots]);
  const errors = useMemo(() => validateOfferings(value, photoSlotIds), [value, photoSlotIds]);
  const errorsByTab = useMemo(() => {
    const byTab = new Map<OfferingTab, typeof errors>(OFFERING_TABS.map((t) => [t, []]));
    if (showErrors) for (const e of errors) byTab.get(e.tab)!.push(e);
    return byTab;
  }, [errors, showErrors]);

  const [jump, setJump] = useState<(OfferingJump & { tab: OfferingTab }) | null>(null);
  const [seenErrorJump, setSeenErrorJump] = useState(errorJump);
  if (errorJump !== seenErrorJump) {
    setSeenErrorJump(errorJump);
    const first = errors[0];
    if (first) {
      setTab(first.tab);
      setExpanded(true);
      setJump({ tab: first.tab, key: first.key, nonce: errorJump });
    }
  }

  /** Applies a structural edit, asking first (unless `ask` is false) when it would delete combination data. */
  const commit: CommitVariation = (next, what, extra = {}, { ask = true } = {}) => {
    const partial = { ...variationPartial(next, value.variationPhotos), ...extra };
    const loss = combinationDataLoss(value, next);
    const photosBefore = Object.keys(prunedVariationPhotos(value.variations, value.variationPhotos)).length;
    const photosLost = photosBefore - Object.keys(partial.variationPhotos ?? {}).length;
    const lost = [
      ...(loss.combinations > 0 ? [describeDataLoss(loss)] : []),
      ...(photosLost > 0 ? [`${photosLost} photo ${photosLost === 1 ? "assignment" : "assignments"}`] : []),
    ];
    if (ask && lost.length > 0) {
      setPending({ message: `${what} deletes ${lost.join(" and ")}.`, partial });
    } else {
      patch(partial);
    }
  };

  const confirm = (message: string, partial: Partial<ListingFormValue>) => setPending({ message, partial });
  const panelProps = { value, patch, confirm, model };
  const jumpFor = (t: OfferingTab) => (jump && jump.tab === t ? jump : null);

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
    <>
      {renderAbove?.({ expanded, commit })}

      <div className="flex items-end justify-between gap-3 border-b border-black/10 dark:border-white/15">
        <div role="tablist" aria-label={label} className="-mb-px flex overflow-x-auto">
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
              {t.key !== "variations" && (errorsByTab.get(t.key)?.length ?? 0) > 0 && (
                <>
                  <span aria-hidden="true" className="ml-1 font-bold text-red-600">!</span>
                  <span className="sr-only">, has errors</span>
                </>
              )}
            </button>
          ))}
        </div>
        {collapsible && (
          <button
            type="button"
            aria-expanded={expanded}
            aria-controls={`${bodyId}-panel`}
            onClick={() => setExpanded((x) => !x)}
            className="mb-1.5 shrink-0 text-sm font-medium text-primary hover:underline"
          >
            {expanded ? "Show less" : "Show more"}
          </button>
        )}
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
          ) : tab === "visibility" ? (
            <VisibilityPanel {...panelProps} errors={errorsByTab.get("visibility")!} jump={jumpFor("visibility")} />
          ) : tab === "photos" ? (
            photosNote ? (
            <p className="text-sm text-zinc-500">{photosNote}</p>
          ) : (
            <PhotosPanel {...panelProps} errors={errorsByTab.get("photos")!} jump={jumpFor("photos")} photoSlots={photoSlots} />
          )
          ) : (
            <FieldTabPanel
              key={tab}
              tab={tab}
              {...panelProps}
              errors={errorsByTab.get(tab)!}
              jump={jumpFor(tab)}
              currencyCode={currencyCode}
              profiles={processingProfiles}
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
    </>
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
  commit: CommitVariation;
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
            onRename={(name) => patch(variationPartial(renameColumn(value, column, name), value.variationPhotos))}
            onScale={(scaleId) =>
              commit(setColumnScale(value, column, scaleId), `Changing the scale of “${variations[column].name}”`)
            }
            onAdd={(input) => patch(variationPartial(addColumnValue(value, column, input), value.variationPhotos))}
            onRemove={(i) =>
              commit(removeColumnValue(value, column, i), `Removing “${variations[column].values[i]}”`, {}, { ask: false })
            }
            onRenameValue={(i, name) => {
              const renamed = renameColumnValue(value, column, i, name);
              if (!renamed) return;
              const photos = { ...value.variationPhotos };
              const oldKey = String(renamed.oldId);
              if (photoPropertyIndex(value.variations) === column && oldKey in photos) {
                photos[String(renamed.newId)] = photos[oldKey];
                delete photos[oldKey];
              }
              patch(variationPartial(renamed.state, photos));
            }}
            onMove={(from, to) => patch(variationPartial(moveColumnValue(value, column, from, to), value.variationPhotos))}
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
  onRenameValue,
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
  onRenameValue: (index: number, name: string) => void;
  onMove: (from: number, to: number) => void;
}) {
  const [editing, setEditing] = useState<{ index: number; draft: string } | null>(null);
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
                  className={`group flex items-center gap-2 rounded-md border border-black/10 px-2 py-1.5 text-sm dark:border-white/15 ${
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
                  {editing?.index === i ? (
                    <input
                      type="text"
                      autoFocus
                      aria-label={`New name for ${name}`}
                      value={editing.draft}
                      onChange={(e) => setEditing({ index: i, draft: e.target.value })}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          onRenameValue(i, editing.draft);
                          setEditing(null);
                        } else if (e.key === "Escape") {
                          setEditing(null);
                        }
                      }}
                      onBlur={() => {
                        onRenameValue(i, editing.draft);
                        setEditing(null);
                      }}
                      className="min-w-0 flex-1 rounded border border-primary bg-white px-1 py-0.5 text-sm outline-none dark:bg-zinc-900"
                    />
                  ) : (
                    <>
                      <span className="min-w-0 flex-1 truncate">{name}</span>
                      <button
                        type="button"
                        onClick={() => setEditing({ index: i, draft: name })}
                        aria-label={`Rename ${name}`}
                        title="Rename"
                        className="shrink-0 text-zinc-400 opacity-0 hover:text-zinc-700 focus-visible:opacity-100 group-hover:opacity-100 dark:hover:text-zinc-200"
                      >
                        ✎
                      </button>
                    </>
                  )}
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
