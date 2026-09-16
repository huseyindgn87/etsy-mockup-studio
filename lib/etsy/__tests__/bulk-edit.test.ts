import { describe, expect, test } from "vitest";
import {
  BULK_SECTIONS,
  CHARACTER_LIMITS,
  isEmptyPatch,
  MAX_BULK_UPDATES,
  MAX_SKU_LENGTH,
  MAX_TAGS,
  MAX_TAG_LENGTH,
  MAX_TITLE_LENGTH,
  normalizeTags,
  parseBulkPatch,
  parseBulkUpdates,
  remainingCharacters,
  splitPatch,
} from "@/lib/etsy/bulk-edit";

const ok = (raw: unknown) => {
  const parsed = parseBulkPatch(raw);
  if (!parsed.ok) throw new Error(`expected a valid patch, got: ${parsed.error}`);
  return parsed.value;
};
const err = (raw: unknown) => {
  const parsed = parseBulkPatch(raw);
  if (parsed.ok) throw new Error("expected the patch to be rejected");
  return parsed.error;
};

describe("character limits", () => {
  test("a title at Etsy's limit is accepted, one over is refused", () => {
    const atLimit = "x".repeat(MAX_TITLE_LENGTH);
    expect(ok({ title: atLimit }).title).toBe(atLimit);
    expect(err({ title: "x".repeat(MAX_TITLE_LENGTH + 1) })).toMatch(
      `Etsy's limit is ${MAX_TITLE_LENGTH}`,
    );
  });

  test("an over-long SKU is refused rather than silently truncated", () => {
    expect(err({ sku: "s".repeat(MAX_SKU_LENGTH + 1) })).toMatch(`limit is ${MAX_SKU_LENGTH}`);
    expect(ok({ sku: "s".repeat(MAX_SKU_LENGTH) }).sku).toHaveLength(MAX_SKU_LENGTH);
  });

  test("a 14th tag, or a tag over 20 characters, is refused", () => {
    const tags = Array.from({ length: MAX_TAGS + 1 }, (_, i) => `tag${i}`);
    expect(err({ tags })).toMatch(`at most ${MAX_TAGS}`);
    expect(err({ tags: ["x".repeat(MAX_TAG_LENGTH + 1)] })).toMatch(
      `longer than ${MAX_TAG_LENGTH} characters`,
    );
  });

  test("the counter reports what's left, and goes negative past the limit", () => {
    expect(remainingCharacters("title", "abc")).toBe(MAX_TITLE_LENGTH - 3);
    expect(remainingCharacters("title", "x".repeat(MAX_TITLE_LENGTH + 5))).toBe(-5);
  });

  test("only fields Etsy actually limits get a counter — description has none", () => {
    expect(remainingCharacters("description", "anything")).toBeNull();
    expect(CHARACTER_LIMITS.description).toBeUndefined();
    expect(Object.keys(CHARACTER_LIMITS).sort()).toEqual(["sku", "title"]);
  });

  test("a description of any length is accepted", () => {
    const long = "word ".repeat(5000);
    expect(ok({ description: long }).description).toBe(long);
  });
});

describe("tag normalisation", () => {
  test("drops blanks and case-insensitive duplicates, keeping order", () => {
    expect(normalizeTags(["Miami", " ", "miami", "Skyline"])).toEqual(["Miami", "Skyline"]);
  });

  test("never returns more than Etsy allows", () => {
    expect(normalizeTags(Array.from({ length: 30 }, (_, i) => `t${i}`))).toHaveLength(MAX_TAGS);
  });
});

describe("values Etsy's spec doesn't document a way to clear", () => {
  test("emptying the tag list is refused out loud, not sent as a guess", () => {
    expect(err({ tags: [] })).toMatch(/can't be emptied/i);
    expect(err({ tags: ["   "] })).toMatch(/can't be emptied/i);
  });

  test("there is no 'no section' value — only moving into a real section", () => {
    expect(err({ shopSectionId: null })).toMatch(/valid shop section/i);
    expect(err({ shopSectionId: 0 })).toMatch(/valid shop section/i);
    expect(ok({ shopSectionId: 12 }).shopSectionId).toBe(12);
  });
});

describe("field validation", () => {
  test("an empty title is refused", () => {
    expect(err({ title: "   " })).toMatch(/can't be empty/i);
  });

  test("title is trimmed", () => {
    expect(ok({ title: "  Mug  " }).title).toBe("Mug");
  });

  test.each([
    ["price", { price: 0 }, /greater than 0/i],
    ["price", { price: -5 }, /greater than 0/i],
    ["quantity", { quantity: -1 }, /0 or more/i],
    ["quantity", { quantity: 1.5 }, /whole number/i],
    ["shipping profile", { shippingProfileId: 0 }, /valid shipping profile/i],
  ])("%s is checked", (_label, raw, message) => {
    expect(err(raw)).toMatch(message);
  });

  test("a price is rounded to Etsy's two decimal places rather than rejected", () => {
    expect(ok({ price: 12.999 }).price).toBe(13);
    expect(ok({ price: 12.994 }).price).toBe(12.99);
  });

  test("quantity may be zero", () => {
    expect(ok({ quantity: 0 }).quantity).toBe(0);
  });

  test("absent fields stay absent — a patch only carries what was targeted", () => {
    const patch = ok({ title: "New title" });
    expect(Object.keys(patch)).toEqual(["title"]);
    expect("description" in patch).toBe(false);
  });

  test("an empty patch is recognisable", () => {
    expect(isEmptyPatch(ok({}))).toBe(true);
    expect(isEmptyPatch(ok({ title: "x" }))).toBe(false);
  });
});

describe("splitting a patch across Etsy's two writes", () => {
  test("listing fields and inventory fields go their separate ways", () => {
    const { listing, inventory } = splitPatch({
      title: "New",
      tags: ["a"],
      shippingProfileId: 3,
      price: 9.5,
      quantity: 2,
      sku: "SKU-1",
    });
    expect(listing).toEqual({ title: "New", tags: ["a"], shippingProfileId: 3 });
    expect(inventory).toEqual({ price: 9.5, quantity: 2, sku: "SKU-1" });
  });

  test("a listing-only patch needs no inventory call", () => {
    const { inventory } = splitPatch({ title: "New" });
    expect(isEmptyPatch(inventory)).toBe(true);
  });
});

describe("per-row targeting — each listing carries only its own changes", () => {
  test("three listings, three different fields", () => {
    const parsed = parseBulkUpdates([
      { listingId: 1, patch: { title: "First" } },
      { listingId: 2, patch: { tags: ["hello"] } },
      { listingId: 3, patch: { shippingProfileId: 44 } },
    ]);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value).toEqual([
      { listingId: 1, patch: { title: "First" } },
      { listingId: 2, patch: { tags: ["hello"] } },
      { listingId: 3, patch: { shippingProfileId: 44 } },
    ]);
    // Nothing bleeds between rows.
    expect(parsed.value[0].patch).not.toHaveProperty("tags");
    expect(parsed.value[1].patch).not.toHaveProperty("title");
    expect(parsed.value[2].patch).not.toHaveProperty("title");
  });

  test("listings with nothing changed are dropped from the save entirely", () => {
    const parsed = parseBulkUpdates([
      { listingId: 1, patch: { title: "Only this one" } },
      { listingId: 2, patch: {} },
    ]);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.map((u) => u.listingId)).toEqual([1]);
  });

  test("apply-to-all arrives as the same value repeated per listing", () => {
    const parsed = parseBulkUpdates(
      [1, 2, 3].map((listingId) => ({ listingId, patch: { shopSectionId: 9 } })),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value).toHaveLength(3);
    for (const update of parsed.value) expect(update.patch).toEqual({ shopSectionId: 9 });
  });

  test("a save with no usable change at all is refused", () => {
    const parsed = parseBulkUpdates([{ listingId: 1, patch: {} }]);
    expect(parsed).toEqual({ ok: false, error: "Nothing to save." });
  });

  test.each([
    ["not an array", {}, /must be an array/i],
    ["empty", [], /nothing to save/i],
    ["a bad id", [{ listingId: 0, patch: { title: "x" } }], /valid `listingId`/i],
    [
      "the same listing twice",
      [
        { listingId: 5, patch: { title: "a" } },
        { listingId: 5, patch: { title: "b" } },
      ],
      /appears twice/i,
    ],
  ])("%s is refused", (_label, raw, message) => {
    const parsed = parseBulkUpdates(raw);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toMatch(message);
  });

  test("one bad value fails the whole save rather than writing the rest", () => {
    const parsed = parseBulkUpdates([
      { listingId: 1, patch: { title: "fine" } },
      { listingId: 2, patch: { title: "x".repeat(MAX_TITLE_LENGTH + 1) } },
    ]);
    expect(parsed.ok).toBe(false);
  });

  test("a save is capped", () => {
    const tooMany = Array.from({ length: MAX_BULK_UPDATES + 1 }, (_, i) => ({
      listingId: i + 1,
      patch: { title: "x" },
    }));
    const parsed = parseBulkUpdates(tooMany);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toMatch(`at most ${MAX_BULK_UPDATES}`);
  });
});

describe("the editor's sidebar", () => {
  test("lists the sections the screen is specified to have, in order", () => {
    expect(BULK_SECTIONS.map((s) => s.label)).toEqual([
      "Title",
      "Description",
      "Tags",
      "Media",
      "Listing details",
      "Optional",
      "Inventory",
      "Shipping",
    ]);
  });

  test("every editable field belongs to exactly one section", () => {
    const fields = BULK_SECTIONS.flatMap((s) => s.fields);
    expect(new Set(fields).size).toBe(fields.length);
  });
});
