/**
 * Etsy's "How it's made" classification fields — `who_made`, `is_supply`,
 * `when_made` — from the Etsy Open API v3 spec (`createDraftListing` /
 * `ShopListing`, confirmed via the Etsy MCP server's `get_endpoint`/
 * `get_schema`, not invented). All three interlock: the schema itself notes
 * `who_made` "Requires 'is_supply' and 'when_made'", and vice versa.
 *
 * Dependency-free so both server code (`lib/etsy/listing-create.ts`,
 * `app/api/mockups/render/route.ts`) and client UI (`ListingForm.tsx`,
 * `app/mockups/page.tsx`) can import it.
 */

export const WHO_MADE_OPTIONS = [
  { value: "i_did", label: "I did" },
  { value: "collective", label: "A member of my shop" },
  { value: "someone_else", label: "Another company or person" },
] as const;
export type WhoMade = (typeof WHO_MADE_OPTIONS)[number]["value"];

/** Etsy's exact `when_made` enum (createDraftListing / ShopListing) — do not add or reorder without re-checking the live schema. */
export const WHEN_MADE_VALUES = [
  "made_to_order",
  "2020_2026",
  "2010_2019",
  "2007_2009",
  "before_2007",
  "2000_2006",
  "1990s",
  "1980s",
  "1970s",
  "1960s",
  "1950s",
  "1940s",
  "1930s",
  "1920s",
  "1910s",
  "1900s",
  "1800s",
  "1700s",
  "before_1700",
] as const;
export type WhenMade = (typeof WHEN_MADE_VALUES)[number];

/** A readable label mechanically derived from the enum token — "2010_2019" -> "2010 – 2019", "before_1700" -> "Before 1700". */
export function formatWhenMade(value: string): string {
  if (value === "made_to_order") return "Made to order";
  const range = /^(\d{3,4})_(\d{3,4})$/.exec(value);
  if (range) return `${range[1]} – ${range[2]}`;
  const before = /^before_(\d{3,4})$/.exec(value);
  if (before) return `Before ${before[1]}`;
  return value;
}

export interface HowItsMade {
  whoMade: WhoMade;
  isSupply: boolean;
  whenMade: WhenMade | string;
  productionPartnerIds: number[];
}

/**
 * Etsy requires a production partner to be named whenever someone else made the
 * item, regardless of when_made/is_supply. This is essential for print-on-demand
 * sellers who disclose a third-party producer (e.g., a print shop). Etsy's
 * official POD seller documentation explicitly allows and expects
 * "Another company or person" + "A finished product" + "Made to order" when a
 * production partner is selected.
 *
 * Returns a user-facing error message, or `null` when the combination is
 * fine to send to Etsy.
 */
export function howItsMadeError(input: HowItsMade): string | null {
  if (input.whoMade !== "someone_else") return null;
  if (input.productionPartnerIds.length === 0) {
    return 'Select at least one production partner — required when "Another company or person" made this item.';
  }
  return null;
}
