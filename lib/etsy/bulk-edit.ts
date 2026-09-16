/**
 * The field model behind bulk listing editing (`/listings/bulk`) — which
 * listing fields can be edited in bulk, the limits Etsy imposes on them, and
 * the validation both the editor screen and the save route run.
 *
 * Dependency-free (no Prisma, no Etsy client) so the client screen and the
 * server route share exactly one definition of what a valid edit is — the
 * same split lib/drafts/constants.ts makes for draft caps.
 *
 * Deliberately narrow: every field here maps to a documented Etsy write.
 * `price`, `quantity` and `sku` are NOT `updateListing` parameters — they
 * live on the listing's inventory record — so they're split out by
 * {@link splitPatch} and applied separately (see lib/etsy/bulk-apply.ts).
 */

/** Etsy truncates longer titles; lib/etsy/listing-create.ts already slices to this. */
export const MAX_TITLE_LENGTH = 140;
/** Etsy's own tag rules — the same pair lib/etsy/publish-listing.ts's `sanitizeTags` enforces. */
export const MAX_TAGS = 13;
export const MAX_TAG_LENGTH = 20;
/** Matches the slice lib/etsy/listing-create.ts applies when writing a SKU. */
export const MAX_SKU_LENGTH = 500;

export type BulkFieldKey =
  | "title"
  | "description"
  | "tags"
  | "shopSectionId"
  | "shouldAutoRenew"
  | "isTaxable"
  | "price"
  | "quantity"
  | "sku"
  | "shippingProfileId";

/**
 * Per-field character limits, for the editor's remaining-character counters.
 * Only fields Etsy actually limits appear here: `description` has no
 * documented maximum anywhere in Etsy's Open API v3 spec or its Listings
 * tutorial, so it deliberately gets no counter rather than an invented one.
 * `tags` is a list, not a text field — see {@link MAX_TAG_LENGTH}.
 */
export const CHARACTER_LIMITS: Partial<Record<BulkFieldKey, number>> = {
  title: MAX_TITLE_LENGTH,
  sku: MAX_SKU_LENGTH,
};

/** Characters still available in `value` for `field`, or null when Etsy sets no limit. */
export function remainingCharacters(field: BulkFieldKey, value: string): number | null {
  const limit = CHARACTER_LIMITS[field];
  return limit == null ? null : limit - value.length;
}

/** One edit to one listing. Every key absent means "leave this listing's value alone". */
export interface BulkListingPatch {
  title?: string;
  description?: string;
  tags?: string[];
  /** Moving into a section only — see `parseBulkPatch` for why clearing isn't offered. */
  shopSectionId?: number;
  shouldAutoRenew?: boolean;
  isTaxable?: boolean;
  shippingProfileId?: number;
  /** Inventory-side — major currency units. */
  price?: number;
  /** Inventory-side. */
  quantity?: number;
  /** Inventory-side. */
  sku?: string;
}

/** Fields written with `updateListing` (`PATCH /shops/{shop}/listings/{listing}`). */
export const LISTING_FIELDS = [
  "title",
  "description",
  "tags",
  "shopSectionId",
  "shouldAutoRenew",
  "isTaxable",
  "shippingProfileId",
] as const satisfies readonly BulkFieldKey[];

/** Fields written through the inventory record (`PUT /listings/{listing}/inventory`). */
export const INVENTORY_FIELDS = ["price", "quantity", "sku"] as const satisfies readonly BulkFieldKey[];

/** One group in the bulk editor's left sidebar. */
export interface BulkSection {
  key: string;
  label: string;
  /** Empty for a section with nothing bulk-editable — Media shows each listing's photos read-only. */
  fields: readonly BulkFieldKey[];
}

export const BULK_SECTIONS: readonly BulkSection[] = [
  { key: "title", label: "Title", fields: ["title"] },
  { key: "description", label: "Description", fields: ["description"] },
  { key: "tags", label: "Tags", fields: ["tags"] },
  // Images can't be meaningfully retyped in a table — this section shows each
  // listing's current photos and links to the editor, rather than faking a field.
  { key: "media", label: "Media", fields: [] },
  { key: "details", label: "Listing details", fields: ["shopSectionId"] },
  { key: "optional", label: "Optional", fields: ["shouldAutoRenew", "isTaxable"] },
  { key: "inventory", label: "Inventory", fields: ["price", "quantity", "sku"] },
  { key: "shipping", label: "Shipping", fields: ["shippingProfileId"] },
];

export function isEmptyPatch(patch: BulkListingPatch): boolean {
  return Object.keys(patch).length === 0;
}

/** Splits a patch into the two Etsy writes it needs. Either half may be empty. */
export function splitPatch(patch: BulkListingPatch): {
  listing: BulkListingPatch;
  inventory: BulkListingPatch;
} {
  const listing: BulkListingPatch = {};
  const inventory: BulkListingPatch = {};
  for (const key of LISTING_FIELDS) {
    if (key in patch) Object.assign(listing, { [key]: patch[key] });
  }
  for (const key of INVENTORY_FIELDS) {
    if (key in patch) Object.assign(inventory, { [key]: patch[key] });
  }
  return { listing, inventory };
}

/**
 * Normalises one tag list to Etsy's rules, dropping blanks and
 * case-insensitive duplicates. Mirrors `sanitizeTags` in
 * lib/etsy/publish-listing.ts — kept separate only so this module stays
 * dependency-free for the client.
 */
export function normalizeTags(tags: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const tag of tags) {
    const trimmed = tag.trim().slice(0, MAX_TAG_LENGTH);
    const key = trimmed.toLowerCase();
    if (!trimmed || seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
    if (out.length >= MAX_TAGS) break;
  }
  return out;
}

export type ParsedPatch = { ok: true; value: BulkListingPatch } | { ok: false; error: string };

function invalid(error: string): ParsedPatch {
  return { ok: false, error };
}

/**
 * Validate and normalise one listing's patch as it arrives from the client.
 * Unlike the publish path's sanitizers, a bad value here is an error rather
 * than a silent drop: the user typed it, and quietly writing something else
 * to their live listing is exactly what this screen must never do.
 */
export function parseBulkPatch(raw: unknown): ParsedPatch {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return invalid("Each edit must be an object.");
  }
  const r = raw as Record<string, unknown>;
  const patch: BulkListingPatch = {};

  if ("title" in r) {
    if (typeof r.title !== "string") return invalid("Title must be text.");
    const title = r.title.trim();
    if (!title) return invalid("Title can't be empty.");
    if (title.length > MAX_TITLE_LENGTH) {
      return invalid(`Title is ${title.length} characters — Etsy's limit is ${MAX_TITLE_LENGTH}.`);
    }
    patch.title = title;
  }

  if ("description" in r) {
    if (typeof r.description !== "string") return invalid("Description must be text.");
    patch.description = r.description;
  }

  if ("tags" in r) {
    if (!Array.isArray(r.tags) || !r.tags.every((t) => typeof t === "string")) {
      return invalid("Tags must be a list of text values.");
    }
    if (r.tags.length > MAX_TAGS) {
      return invalid(`${r.tags.length} tags — Etsy allows at most ${MAX_TAGS}.`);
    }
    const tooLong = (r.tags as string[]).find((t) => t.trim().length > MAX_TAG_LENGTH);
    if (tooLong !== undefined) {
      return invalid(`Tag "${tooLong.trim()}" is longer than ${MAX_TAG_LENGTH} characters.`);
    }
    const tags = normalizeTags(r.tags as string[]);
    // Same reasoning as `shopSectionId` below: Etsy's spec doesn't document
    // how a form-encoded PATCH empties an array field, so emptying one from
    // here is refused out loud instead of sent as a guess.
    if (tags.length === 0) {
      return invalid("Tags can't be emptied from here — keep at least one tag, or clear them on Etsy.");
    }
    patch.tags = tags;
  }

  if ("shopSectionId" in r) {
    // Deliberately no "no section" option. Etsy's spec documents the field's
    // default as null but not how a PATCH clears an existing one, and this
    // screen writes to live listings — so only moving a listing *into* a
    // section is offered, rather than guessing at a clearing value.
    if (!Number.isInteger(r.shopSectionId) || (r.shopSectionId as number) <= 0) {
      return invalid("Choose a valid shop section.");
    }
    patch.shopSectionId = r.shopSectionId as number;
  }

  for (const key of ["shouldAutoRenew", "isTaxable"] as const) {
    if (key in r) {
      if (typeof r[key] !== "boolean") return invalid(`${key} must be true or false.`);
      patch[key] = r[key] as boolean;
    }
  }

  if ("shippingProfileId" in r) {
    if (!Number.isInteger(r.shippingProfileId) || (r.shippingProfileId as number) <= 0) {
      return invalid("Choose a valid shipping profile.");
    }
    patch.shippingProfileId = r.shippingProfileId as number;
  }

  if ("price" in r) {
    if (typeof r.price !== "number" || !Number.isFinite(r.price) || r.price <= 0) {
      return invalid("Price must be greater than 0.");
    }
    // Etsy prices carry two decimal places; round rather than reject so a
    // value typed as 12.999 doesn't fail the whole save.
    patch.price = Math.round(r.price * 100) / 100;
  }

  if ("quantity" in r) {
    if (!Number.isInteger(r.quantity) || (r.quantity as number) < 0) {
      return invalid("Quantity must be a whole number of 0 or more.");
    }
    patch.quantity = r.quantity as number;
  }

  if ("sku" in r) {
    if (typeof r.sku !== "string") return invalid("SKU must be text.");
    if (r.sku.length > MAX_SKU_LENGTH) {
      return invalid(`SKU is ${r.sku.length} characters — Etsy's limit is ${MAX_SKU_LENGTH}.`);
    }
    patch.sku = r.sku.trim();
  }

  return { ok: true, value: patch };
}

/** One listing's edit, as the save request carries it. */
export interface BulkUpdate {
  listingId: number;
  patch: BulkListingPatch;
}

export type ParsedUpdates = { ok: true; value: BulkUpdate[] } | { ok: false; error: string };

/** How many listings one save request may write. Keeps a single click's Etsy fan-out bounded. */
export const MAX_BULK_UPDATES = 100;

/** Validate the whole `{ updates: [...] }` body of a bulk save. */
export function parseBulkUpdates(raw: unknown): ParsedUpdates {
  if (!Array.isArray(raw)) return { ok: false, error: "`updates` must be an array." };
  if (raw.length === 0) return { ok: false, error: "Nothing to save." };
  if (raw.length > MAX_BULK_UPDATES) {
    return { ok: false, error: `A save can change at most ${MAX_BULK_UPDATES} listings at once.` };
  }

  const value: BulkUpdate[] = [];
  const seen = new Set<number>();
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") return { ok: false, error: "Each edit must be an object." };
    const listingId = (entry as { listingId?: unknown }).listingId;
    if (!Number.isInteger(listingId) || (listingId as number) <= 0) {
      return { ok: false, error: "Each edit needs a valid `listingId`." };
    }
    if (seen.has(listingId as number)) {
      return { ok: false, error: `Listing ${listingId} appears twice in one save.` };
    }
    seen.add(listingId as number);

    const parsed = parseBulkPatch((entry as { patch?: unknown }).patch);
    if (!parsed.ok) return { ok: false, error: parsed.error };
    if (isEmptyPatch(parsed.value)) continue; // nothing targeted at this listing
    value.push({ listingId: listingId as number, patch: parsed.value });
  }

  if (value.length === 0) return { ok: false, error: "Nothing to save." };
  return { ok: true, value };
}
