/**
 * Etsy's own per-listing variation limits (not arbitrary caps of ours) —
 * shared between the client-side ListingForm UI and the server-side publish
 * route so the two can never drift apart.
 */

/** Total option combinations a listing's 1-2 variation types can produce. */
export const MAX_VARIATION_COMBINATIONS = 4900;

/** How many of those combinations can carry a unique price/SKU/quantity. */
export const MAX_PRICED_ROWS = 400;

/** Options allowed on a single variation type (not a total across both). */
export const MAX_OPTIONS_PER_VARIATION = 70;
