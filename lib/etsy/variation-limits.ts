/**
 * Etsy's own per-listing variation limits (not arbitrary caps of ours) —
 * shared between the client-side ListingForm UI and the server-side publish
 * route so the two can never drift apart. Verified against Etsy's "Third
 * Variation" tutorial (developers.etsy.com/documentation/tutorials/third-variation):
 *
 *   "For listings with three variations, the maximum number of products is 2500."
 *   "For listings with two or three variations where any *_on_property field
 *    has all properties, then the maximum number of products is 400."
 */

/** Etsy allows up to 3 variation types per listing (the 3rd needs `max_variations_supported=3`). */
export const MAX_VARIATIONS = 3;

/** Options allowed on a single variation type (not a total across all of them). */
export const MAX_OPTIONS_PER_VARIATION = 70;

/** Up to 2 variation types: 70 options each. */
const MAX_COMBINATIONS_UP_TO_2_VARIATIONS = 4900;

/** With a 3rd variation type, Etsy's flat cap replaces the option-count math above. */
const MAX_COMBINATIONS_WITH_3_VARIATIONS = 2500;

/** The stricter cap that applies once a price/quantity/SKU/processing-profile field varies by every variation type. */
export const MAX_COMBINATIONS_FULLY_BOUND = 400;

/** Outer safety bound for defensive server-side truncation — the loosest limit that could ever legitimately apply. */
export const MAX_COMBINATIONS_HARD_CAP = MAX_COMBINATIONS_UP_TO_2_VARIATIONS;

/**
 * The combination-count limit that currently applies. Etsy drops the usual
 * 2500/4900 ceiling to 400 the moment any `*_on_property` field (price,
 * quantity, SKU, or processing profile) is bound to every configured
 * variation type — at that point every combination needs its own row anyway,
 * so the product count itself is capped.
 */
export function maxCombinationsFor(variationCount: number, anyFieldBoundToAllVariations: boolean): number {
  if (anyFieldBoundToAllVariations) return MAX_COMBINATIONS_FULLY_BOUND;
  return variationCount >= 3 ? MAX_COMBINATIONS_WITH_3_VARIATIONS : MAX_COMBINATIONS_UP_TO_2_VARIATIONS;
}
