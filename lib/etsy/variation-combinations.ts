/**
 * The pure model behind the listing editor's Variations section: the
 * combination set every sub-tab shares, the column edits (choose a property,
 * add / remove / reorder its values), and what an edit would destroy.
 *
 * Combination data lives on the form keyed by value ids, never by position:
 * `variationRows[field]` by the ids of the variations that field varies by
 * (`appliesTo`), `variationRowEnabled` by every id in the combination. So a
 * reorder never touches data, and an edit that stops a key from being
 * reachable is exactly what loses it.
 */

import { MAX_COMBINATIONS_HARD_CAP, MAX_OPTIONS_PER_VARIATION, MAX_VARIATIONS } from "@/lib/etsy/variation-limits";

export interface VariationDimension {
  propertyId: number;
  name: string;
  isCustom: boolean;
  valueIds: number[];
  values: string[];
  linksPhotos: boolean;
  scaleId?: number | null;
}

export type CombinationField = "price" | "readiness" | "quantity" | "sku";

export const COMBINATION_FIELDS: readonly CombinationField[] = ["price", "quantity", "sku", "readiness"];

export const COMBINATION_FIELD_LABEL: Record<CombinationField, string> = {
  price: "price",
  quantity: "quantity",
  sku: "SKU",
  readiness: "processing profile",
};

export interface VariationState {
  variations: VariationDimension[];
  variationToggles: Record<CombinationField, { enabled: boolean; appliesTo: number[] }>;
  variationRows: Record<CombinationField, Record<string, string>>;
  variationRowEnabled: Record<string, boolean>;
}

/** Etsy's reserved "custom variation" property ids, in the order they're handed out. */
export const CUSTOM_PROPERTY_IDS = [513, 514, 516] as const;

export interface Combination {
  /** Every value id joined with ":" — the `variationRowEnabled` key. */
  key: string;
  valueIds: readonly number[];
  values: readonly string[];
}

export interface CombinationModel {
  signature: string;
  /** The cross-product size, even when it's too large to list. */
  count: number;
  /** Set when `count` is over Etsy's loosest limit — `combinations` is then empty. */
  tooMany: boolean;
  combinations: readonly Combination[];
  byKey: ReadonlyMap<string, Combination>;
}

/** 0 with no variations or when any variation has no values yet. */
export function combinationCount(variations: readonly VariationDimension[]): number {
  if (variations.length === 0) return 0;
  return variations.reduce((n, v) => n * v.valueIds.length, 1);
}

/** Changes whenever a combination's ids, names or order would. */
export function combinationSignature(variations: readonly VariationDimension[]): string {
  return variations.map((v) => `${v.valueIds.join(",")}=${v.values.join("\u001f")}`).join("\u001e");
}

export function buildCombinationModel(
  variations: readonly VariationDimension[],
  signature = combinationSignature(variations),
): CombinationModel {
  const count = combinationCount(variations);
  const tooMany = count > MAX_COMBINATIONS_HARD_CAP;
  const combinations: Combination[] = [];
  if (count > 0 && !tooMany) {
    let keys = [""];
    let ids: number[][] = [[]];
    let names: string[][] = [[]];
    variations.forEach((v, d) => {
      const nextKeys: string[] = [];
      const nextIds: number[][] = [];
      const nextNames: string[][] = [];
      for (let r = 0; r < keys.length; r++) {
        for (let i = 0; i < v.valueIds.length; i++) {
          nextKeys.push(d === 0 ? String(v.valueIds[i]) : `${keys[r]}:${v.valueIds[i]}`);
          nextIds.push([...ids[r], v.valueIds[i]]);
          nextNames.push([...names[r], v.values[i]]);
        }
      }
      keys = nextKeys;
      ids = nextIds;
      names = nextNames;
    });
    for (let r = 0; r < keys.length; r++) {
      combinations.push({ key: keys[r], valueIds: ids[r], values: names[r] });
    }
  }
  return {
    signature,
    count,
    tooMany,
    combinations,
    byKey: new Map(combinations.map((c) => [c.key, c])),
  };
}

/**
 * A one-entry memo: returns the previous model while the variations are the
 * same array or structurally equal, so a keystroke anywhere else in the form
 * (or in a combination's own cell) never rebuilds hundreds of rows.
 */
export function createCombinationCache(): (variations: readonly VariationDimension[]) => CombinationModel {
  let last: { variations: readonly VariationDimension[]; model: CombinationModel } | null = null;
  return (variations) => {
    if (last && last.variations === variations) return last.model;
    const signature = combinationSignature(variations);
    const model = last && last.model.signature === signature ? last.model : buildCombinationModel(variations, signature);
    last = { variations, model };
    return model;
  };
}

/** The `variationRows` key for one combination's ids, scoped to the variations a field varies by. */
export function cellKeyFor(appliesTo: readonly number[], valueIds: readonly number[]): string {
  return appliesTo.map((i) => valueIds[i]).join(":");
}

const NO_VALUE = "\u2205";

/**
 * Every cell key a field can reach. A variation with no values yet counts as
 * one unmatched value, so picking a property for a new column doesn't orphan
 * cells that don't vary by it. Null when the field isn't in use.
 */
function reachableCells(state: VariationState, field: CombinationField): Set<string> | null {
  const toggle = state.variationToggles[field];
  if (!toggle.enabled || toggle.appliesTo.length === 0) return null;
  if (toggle.appliesTo.some((i) => i < 0 || i >= state.variations.length)) return null;
  let keys = [""];
  toggle.appliesTo.forEach((index, d) => {
    const v = state.variations[index];
    const ids = v.valueIds.length > 0 ? v.valueIds.map(String) : [NO_VALUE];
    const next: string[] = [];
    for (const k of keys) for (const id of ids) next.push(d === 0 ? id : `${k}:${id}`);
    keys = next;
  });
  return new Set(keys);
}

export interface CombinationDataLoss {
  /** Combinations of the current grid that hold at least one value the edit deletes. */
  combinations: number;
  fields: { field: CombinationField; combinations: number }[];
}

/** What going from `before` to `after` would delete; `combinations: 0` means nothing. */
export function combinationDataLoss(before: VariationState, after: VariationState): CombinationDataLoss {
  const lostByField = new Map<CombinationField, Set<string>>();
  for (const field of COMBINATION_FIELDS) {
    const reachable = reachableCells(before, field);
    if (!reachable) continue;
    const stillReachable = reachableCells(after, field);
    const rows = before.variationRows[field];
    const lost = new Set<string>();
    for (const key of reachable) {
      if ((rows[key] ?? "").trim() !== "" && !stillReachable?.has(key)) lost.add(key);
    }
    if (lost.size > 0) lostByField.set(field, lost);
  }
  if (lostByField.size === 0) return { combinations: 0, fields: [] };

  const sizes = before.variations.map((v) => Math.max(v.valueIds.length, 1));
  const fields = [...lostByField].map(([field, lost]) => {
    const appliesTo = before.variationToggles[field].appliesTo;
    const rest = sizes.reduce((n, size, i) => (appliesTo.includes(i) ? n : n * size), 1);
    return { field, combinations: lost.size * rest };
  });

  const total = sizes.reduce((n, s) => n * s, 1);
  if (total > MAX_COMBINATIONS_HARD_CAP) {
    return { combinations: Math.max(...fields.map((f) => f.combinations)), fields };
  }
  let combinations = 0;
  const index = new Array<number>(sizes.length).fill(0);
  const ids = before.variations.map((v) => (v.valueIds.length > 0 ? v.valueIds.map(String) : [NO_VALUE]));
  for (let n = 0; n < total; n++) {
    const current = index.map((i, d) => ids[d][i]);
    for (const [field, lost] of lostByField) {
      const key = before.variationToggles[field].appliesTo.map((i) => current[i]).join(":");
      if (lost.has(key)) {
        combinations++;
        break;
      }
    }
    for (let d = sizes.length - 1; d >= 0; d--) {
      if (++index[d] < sizes[d]) break;
      index[d] = 0;
    }
  }
  return { combinations, fields };
}

/** "3 combinations with price or SKU data" — for the confirmation before a destructive edit. */
export function describeDataLoss(loss: CombinationDataLoss): string {
  const names = loss.fields.map((f) => COMBINATION_FIELD_LABEL[f.field]);
  const list = names.length > 1 ? `${names.slice(0, -1).join(", ")} or ${names.at(-1)}` : names[0];
  return `${loss.combinations} ${loss.combinations === 1 ? "combination" : "combinations"} with ${list} data`;
}

/** Drops cells and visibility flags no combination can reach any more. */
function prune(state: VariationState): VariationState {
  let variationRows = state.variationRows;
  for (const field of COMBINATION_FIELDS) {
    const reachable = reachableCells(state, field);
    if (!reachable) continue;
    const rows = state.variationRows[field];
    if (Object.keys(rows).every((k) => reachable.has(k))) continue;
    const kept: Record<string, string> = {};
    for (const k of Object.keys(rows)) if (reachable.has(k)) kept[k] = rows[k];
    variationRows = { ...variationRows, [field]: kept };
  }
  const model = buildCombinationModel(state.variations);
  let variationRowEnabled = state.variationRowEnabled;
  if (!model.tooMany && Object.keys(variationRowEnabled).some((k) => !model.byKey.has(k))) {
    variationRowEnabled = Object.fromEntries(
      Object.entries(variationRowEnabled).filter(([k]) => model.byKey.has(k)),
    );
  }
  if (variationRows === state.variationRows && variationRowEnabled === state.variationRowEnabled) return state;
  return { ...state, variationRows, variationRowEnabled };
}

function withVariation(state: VariationState, index: number, next: VariationDimension): VariationState {
  const variations = state.variations.map((v, i) => (i === index ? next : v));
  return prune({ ...state, variations });
}

/** 513/514/516 — the first reserved custom id no other column uses. */
/** What a category change leaves: no variations and no combination data. */
export function clearedVariationState(): VariationState {
  const toggle = () => ({ enabled: false, appliesTo: [] });
  return {
    variations: [],
    variationToggles: { price: toggle(), readiness: toggle(), quantity: toggle(), sku: toggle() },
    variationRows: { price: {}, readiness: {}, quantity: {}, sku: {} },
    variationRowEnabled: {},
  };
}

export function nextCustomPropertyId(variations: readonly VariationDimension[], replacingIndex: number | null): number {
  const used = new Set(variations.filter((v, i) => i !== replacingIndex && v.isCustom).map((v) => v.propertyId));
  return CUSTOM_PROPERTY_IDS.find((id) => !used.has(id)) ?? CUSTOM_PROPERTY_IDS[0];
}

/**
 * Puts a property in column `index` with no values: replaces that column, or
 * appends when `index` is the next free one. Choosing the property a column
 * already has changes nothing.
 */
export function setColumnProperty(
  state: VariationState,
  index: number,
  property: Pick<VariationDimension, "propertyId" | "name" | "isCustom"> & { scaleId?: number | null },
): VariationState {
  if (index < 0 || index > state.variations.length || index >= MAX_VARIATIONS) return state;
  const current = state.variations[index];
  if (current && !property.isCustom && !current.isCustom && current.propertyId === property.propertyId) return state;
  const dimension: VariationDimension = {
    propertyId: property.propertyId,
    name: property.name,
    isCustom: property.isCustom,
    valueIds: [],
    values: [],
    linksPhotos: false,
    scaleId: property.scaleId ?? null,
  };
  if (index === state.variations.length) return prune({ ...state, variations: [...state.variations, dimension] });
  return withVariation(state, index, dimension);
}

/** Empties column `index`; later columns shift left and fields stop varying by it. */
export function removeColumn(state: VariationState, index: number): VariationState {
  if (index < 0 || index >= state.variations.length) return state;
  const variations = state.variations.filter((_, i) => i !== index);
  const variationToggles = { ...state.variationToggles };
  let variationRows = state.variationRows;
  for (const field of COMBINATION_FIELDS) {
    const toggle = state.variationToggles[field];
    const appliesTo = toggle.appliesTo.filter((i) => i !== index).map((i) => (i > index ? i - 1 : i));
    const enabled = toggle.enabled && appliesTo.length > 0;
    variationToggles[field] = { enabled, appliesTo };
    if (toggle.enabled && !enabled) variationRows = { ...variationRows, [field]: {} };
  }
  return prune({ ...state, variations, variationToggles, variationRows });
}

export function renameColumn(state: VariationState, index: number, name: string): VariationState {
  const current = state.variations[index];
  if (!current || !current.isCustom || current.name === name) return state;
  return { ...state, variations: state.variations.map((v, i) => (i === index ? { ...v, name } : v)) };
}

/** A different scale has different values, so the column's values are cleared. */
export function setColumnScale(state: VariationState, index: number, scaleId: number | null): VariationState {
  const current = state.variations[index];
  if (!current || (current.scaleId ?? null) === scaleId) return state;
  return withVariation(state, index, { ...current, scaleId, valueIds: [], values: [] });
}

/**
 * Appends a value. `valueId` is Etsy's id for one of the property's listed
 * values; without one the value is free text and gets a column-unique id —
 * positive on a custom variation, negative on an Etsy property (the payload
 * builder sends negative ids as `value_id: null`). Blank names, duplicates
 * (case-insensitive) and a full column are ignored.
 */
export function addColumnValue(
  state: VariationState,
  index: number,
  input: { name: string; valueId?: number | null },
): VariationState {
  const current = state.variations[index];
  const name = input.name.trim();
  if (!current || !name || current.valueIds.length >= MAX_OPTIONS_PER_VARIATION) return state;
  if (current.values.some((v) => v.trim().toLowerCase() === name.toLowerCase())) return state;
  let id: number;
  if (input.valueId != null && input.valueId > 0) {
    if (current.valueIds.includes(input.valueId)) return state;
    id = input.valueId;
  } else if (current.isCustom) {
    id = Math.max(0, ...current.valueIds) + 1;
  } else {
    id = Math.min(0, ...current.valueIds) - 1;
  }
  return withVariation(state, index, {
    ...current,
    valueIds: [...current.valueIds, id],
    values: [...current.values, name],
  });
}

export function removeColumnValue(state: VariationState, index: number, valueIndex: number): VariationState {
  const current = state.variations[index];
  if (!current || valueIndex < 0 || valueIndex >= current.valueIds.length) return state;
  return withVariation(state, index, {
    ...current,
    valueIds: current.valueIds.filter((_, i) => i !== valueIndex),
    values: current.values.filter((_, i) => i !== valueIndex),
  });
}

/** Moves a value within its own column — the order buyers see. Data is keyed by id, so none moves or is lost. */
export function moveColumnValue(state: VariationState, index: number, from: number, to: number): VariationState {
  const current = state.variations[index];
  if (!current || from === to) return state;
  const n = current.valueIds.length;
  if (from < 0 || to < 0 || from >= n || to >= n) return state;
  const valueIds = [...current.valueIds];
  const values = [...current.values];
  valueIds.splice(to, 0, ...valueIds.splice(from, 1));
  values.splice(to, 0, ...values.splice(from, 1));
  return { ...state, variations: state.variations.map((v, i) => (i === index ? { ...v, valueIds, values } : v)) };
}

/**
 * Renames one value. Its old id may be Etsy's id for the old name, so the
 * value gets a fresh free-text id (as `addColumnValue` would give it) and
 * every price, quantity, SKU, processing profile and on/off cell keyed by the
 * old id moves to the new one — only the name changes. Blank names, no-op
 * renames and names another value in the column already has are ignored.
 * Returns the ids too, so the caller can move a photo assignment keyed by it.
 */
export function renameColumnValue(
  state: VariationState,
  index: number,
  valueIndex: number,
  name: string,
): { state: VariationState; oldId: number; newId: number } | null {
  const current = state.variations[index];
  const trimmed = name.trim();
  if (!current || valueIndex < 0 || valueIndex >= current.valueIds.length || !trimmed) return null;
  if (current.values[valueIndex] === trimmed) return null;
  if (current.values.some((v, i) => i !== valueIndex && v.trim().toLowerCase() === trimmed.toLowerCase())) return null;

  const oldId = current.valueIds[valueIndex];
  const newId = current.isCustom ? Math.max(0, ...current.valueIds) + 1 : Math.min(0, ...current.valueIds) - 1;
  const remapKey = (key: string, columns: readonly number[]) =>
    key
      .split(":")
      .map((part, p) => (columns[p] === index && part === String(oldId) ? String(newId) : part))
      .join(":");
  const remap = <T>(rows: Record<string, T>, columns: readonly number[]) =>
    Object.fromEntries(Object.entries(rows).map(([k, v]) => [remapKey(k, columns), v]));

  const allColumns = state.variations.map((_, i) => i);
  const variationRows = { ...state.variationRows };
  for (const field of COMBINATION_FIELDS) {
    variationRows[field] = remap(state.variationRows[field], state.variationToggles[field].appliesTo);
  }
  return {
    oldId,
    newId,
    state: {
      ...state,
      variations: state.variations.map((v, i) =>
        i === index
          ? {
              ...v,
              valueIds: v.valueIds.map((id, j) => (j === valueIndex ? newId : id)),
              values: v.values.map((value, j) => (j === valueIndex ? trimmed : value)),
            }
          : v,
      ),
      variationRows,
      variationRowEnabled: remap(state.variationRowEnabled, allColumns),
    },
  };
}
