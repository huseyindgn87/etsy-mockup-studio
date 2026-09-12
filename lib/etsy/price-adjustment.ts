/**
 * Bulk price adjustment for the variations combination grid — applied to
 * whichever rows the user has checked (see `ListingForm.tsx`'s
 * `VariationTable`). Pure so it's unit-testable without a DOM.
 */

export interface PriceAdjustment {
  kind: "fixed" | "percent";
  amount: number;
}

/**
 * Parses a fixed amount ("2.00", "+2.00", "-2.00") or a percentage ("10%",
 * "-10%"). Returns null when the input matches neither form.
 */
export function parsePriceAdjustment(input: string): PriceAdjustment | null {
  const trimmed = input.trim();
  const percentMatch = /^([+-]?\d+(?:\.\d+)?)%$/.exec(trimmed);
  if (percentMatch) {
    const amount = Number.parseFloat(percentMatch[1]);
    return Number.isFinite(amount) ? { kind: "percent", amount } : null;
  }
  const fixedMatch = /^([+-]?\d+(?:\.\d+)?)$/.exec(trimmed);
  if (fixedMatch) {
    const amount = Number.parseFloat(fixedMatch[1]);
    return Number.isFinite(amount) ? { kind: "fixed", amount } : null;
  }
  return null;
}

/** Applies a parsed adjustment to a current price — rounded to 2 decimals, never negative (Etsy requires a positive price). */
export function applyPriceAdjustment(current: number, adjustment: PriceAdjustment): number {
  const next =
    adjustment.kind === "percent"
      ? current * (1 + adjustment.amount / 100)
      : current + adjustment.amount;
  return Math.max(0, Math.round(next * 100) / 100);
}
