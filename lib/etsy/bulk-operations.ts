/**
 * The bulk editor's top-bar edits for the inventory fields — price and
 * quantity operations, SKU text placement, a processing profile — applied to
 * either a plain listing's single value or a variation listing's form (every
 * row of it, or its listing-wide value when the field doesn't vary).
 */

import { buildCombinationModel } from "@/lib/etsy/variation-combinations";
import {
  applyNumericBulk,
  individualIndices,
  offeringRows,
  type BulkOperation,
  type OfferingState,
} from "@/lib/etsy/variation-offerings";
import type { CombinationField } from "@/lib/etsy/variation-combinations";

export type NumberOperation = "set" | "increase" | "decrease";
export type AmountUnit = "amount" | "percent";

export interface NumericInstruction {
  operation: NumberOperation;
  amount: string;
  unit: AmountUnit;
}

export type SkuPosition = "before" | "after" | "replace";

const PRICE_RE = /^\d+(\.\d{1,2})?$/;
const QUANTITY_RE = /^\d+$/;
const PERCENT_RE = /^\d+(\.\d+)?$/;

const EMPTY_STATE: OfferingState = {
  variations: [],
  variationToggles: {
    price: { enabled: false, appliesTo: [] },
    quantity: { enabled: false, appliesTo: [] },
    sku: { enabled: false, appliesTo: [] },
    readiness: { enabled: false, appliesTo: [] },
  },
  variationRows: { price: {}, quantity: {}, sku: {}, readiness: {} },
  variationRowEnabled: {},
  price: "",
  quantity: "",
  sku: "",
  readinessStateId: null,
  variationPhotos: {},
};

/** Apply stays disabled until this is true. */
export function isUsableNumeric(field: "price" | "quantity", instruction: NumericInstruction): boolean {
  const amount = instruction.amount.trim();
  if (instruction.unit === "percent") {
    return field === "price" && instruction.operation !== "set" && PERCENT_RE.test(amount);
  }
  return (field === "price" ? PRICE_RE : QUANTITY_RE).test(amount);
}

function bulkOperation(instruction: NumericInstruction): BulkOperation {
  if (instruction.unit === "percent") return instruction.operation === "increase" ? "increasePercent" : "decreasePercent";
  return instruction.operation;
}

/** One value after the operation, or null when it can't apply (nothing to change, or it would go negative). */
export function applyNumericToValue(
  field: "price" | "quantity",
  current: string,
  instruction: NumericInstruction,
): string | null {
  if (!isUsableNumeric(field, instruction)) return null;
  const result = applyNumericBulk(
    { ...EMPTY_STATE, [field]: current },
    field,
    null,
    bulkOperation(instruction),
    instruction.amount,
  );
  if (!result.ok || result.skipped > 0) return null;
  return (result.patch[field] as string | undefined) ?? current;
}

/** Every row key a field has on this form, or null when the field is listing-wide. */
function rowKeys(state: OfferingState, field: CombinationField): string[] | null {
  const indices = individualIndices(state, field);
  if (indices.length === 0) return null;
  return offeringRows(buildCombinationModel(state.variations), indices).map((r) => r.key);
}

/** The operation on every price or quantity a variation form holds; null when it can't apply. */
export function applyNumericToForm(
  state: OfferingState,
  field: "price" | "quantity",
  instruction: NumericInstruction,
): Partial<OfferingState> | null {
  if (!isUsableNumeric(field, instruction)) return null;
  const result = applyNumericBulk(state, field, rowKeys(state, field), bulkOperation(instruction), instruction.amount);
  return result.ok ? result.patch : null;
}

export function applySkuText(current: string, position: SkuPosition, text: string): string {
  if (position === "replace") return text;
  return position === "before" ? `${text}${current}` : `${current}${text}`;
}

/** SKU text placed on every SKU a variation form holds. */
export function applySkuToForm(state: OfferingState, position: SkuPosition, text: string): Partial<OfferingState> {
  const keys = rowKeys(state, "sku");
  if (keys == null) return { sku: applySkuText(state.sku, position, text) };
  const cells = { ...state.variationRows.sku };
  for (const key of keys) cells[key] = applySkuText(cells[key] ?? state.sku, position, text);
  return { variationRows: { ...state.variationRows, sku: cells } };
}

/** One processing profile for every combination of a variation form. */
export function applyProcessingToForm(state: OfferingState, readinessStateId: number): Partial<OfferingState> {
  const keys = rowKeys(state, "readiness");
  if (keys == null) return { readinessStateId };
  const cells = Object.fromEntries(keys.map((key) => [key, String(readinessStateId)]));
  return { readinessStateId, variationRows: { ...state.variationRows, readiness: cells } };
}
