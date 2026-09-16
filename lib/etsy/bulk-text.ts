/**
 * The text transforms behind the bulk editor's Title and Description control
 * ("Add before" / "Add after" / "Find and replace"), and the list-append the
 * Tags and Materials controls use.
 *
 * Pure and dependency-free: the screen previews a transform with the same
 * function the row values are written with, so what a user sees is exactly
 * what a save would send.
 *
 * Every function here is *additive or substitutive by construction* — none of
 * them can return an empty result from a non-empty input unless the user
 * explicitly asked to replace text with nothing. In particular
 * {@link appendToList} never drops an existing entry: the bulk Tags control is
 * specified to add tags to each listing's existing ones and must never clear
 * or replace them.
 */

export const TEXT_TRANSFORM_MODES = [
  { value: "before", label: "Add before" },
  { value: "after", label: "Add after" },
  { value: "replace", label: "Find and replace" },
] as const;

export type TextTransformMode = (typeof TEXT_TRANSFORM_MODES)[number]["value"];

export function isTextTransformMode(value: unknown): value is TextTransformMode {
  return TEXT_TRANSFORM_MODES.some((m) => m.value === value);
}

export interface TextTransform {
  mode: TextTransformMode;
  /** The text to add, or — for "replace" — the replacement. */
  value: string;
  /** "replace" only: the text being searched for. */
  find?: string;
}

/**
 * Apply one transform to one listing's current text.
 *
 * "before"/"after" join with a single space when the existing text is
 * non-empty, so prefixing a title doesn't produce "NewTitleOld title"; an
 * empty current value simply becomes the added text. "replace" swaps every
 * occurrence, and is a no-op when `find` is empty (replacing "nothing"
 * everywhere has no meaning Etsy could store) or absent from the text.
 */
export function applyTextTransform(current: string, transform: TextTransform): string {
  const { mode, value } = transform;
  if (mode === "replace") {
    const find = transform.find ?? "";
    if (!find) return current;
    return current.split(find).join(value);
  }
  const addition = value;
  if (!addition) return current;
  if (!current) return addition;
  return mode === "before" ? `${addition} ${current}` : `${current} ${addition}`;
}

/**
 * Add `entry` to an existing list, keeping everything already there.
 *
 * Case-insensitive duplicates are ignored (Etsy treats "Gift" and "gift" as
 * the same tag) and the list is capped at `max` — once full, the existing
 * entries are returned untouched rather than something being evicted to make
 * room. `trimTo` bounds a single entry's length.
 */
export function appendToList(
  current: readonly string[],
  entry: string,
  { max, trimTo }: { max: number; trimTo: number },
): string[] {
  const addition = entry.trim().slice(0, trimTo);
  if (!addition) return [...current];
  if (current.length >= max) return [...current];
  if (current.some((existing) => existing.trim().toLowerCase() === addition.toLowerCase())) {
    return [...current];
  }
  return [...current, addition];
}
