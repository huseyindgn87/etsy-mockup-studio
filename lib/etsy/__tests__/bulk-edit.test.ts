import { describe, expect, test } from "vitest";
import {
  ALL_BULK_FIELDS,
  ATTRIBUTE_FIELDS,
  BULK_GROUPS,
  CHARACTER_LIMITS,
  DIMENSION_UNITS,
  MAX_BULK_UPDATES,
  MAX_MATERIAL_LENGTH,
  MAX_SKU_LENGTH,
  MAX_TAGS,
  MAX_TAG_LENGTH,
  MAX_TITLE_LENGTH,
  WEIGHT_UNITS,
  applyKindFor,
  findAttributeProperty,
  isAttributeField,
  isEmptyPatch,
  isReadOnlyField,
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

/** A valid About trio — Etsy requires all three together. */
const ABOUT = { whoMade: "i_did", whenMade: "made_to_order", isSupply: false };

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

describe("tag and material normalisation", () => {
  test("drops blanks and case-insensitive duplicates, keeping order", () => {
    expect(normalizeTags(["Miami", " ", "miami", "Skyline"])).toEqual(["Miami", "Skyline"]);
  });

  test("never returns more than Etsy allows", () => {
    expect(normalizeTags(Array.from({ length: 30 }, (_, i) => `t${i}`))).toHaveLength(MAX_TAGS);
  });

  test("materials are normalised the same way", () => {
    expect(ok({ materials: ["Cotton", "cotton", " "] }).materials).toEqual(["Cotton"]);
    expect(ok({ materials: ["x".repeat(MAX_MATERIAL_LENGTH + 10)] }).materials![0]).toHaveLength(
      MAX_MATERIAL_LENGTH,
    );
  });
});

describe("values Etsy's spec doesn't document a way to clear", () => {
  test("emptying the tag list is refused out loud, not sent as a guess", () => {
    expect(err({ tags: [] })).toMatch(/can't be emptied/i);
    expect(err({ tags: ["   "] })).toMatch(/can't be emptied/i);
  });

  test("emptying the material list is refused the same way", () => {
    expect(err({ materials: [] })).toMatch(/can't be emptied/i);
  });

  test("there is no 'no section' value — only moving into a real section", () => {
    expect(err({ shopSectionId: null })).toMatch(/valid shop section/i);
    expect(err({ shopSectionId: 0 })).toMatch(/valid shop section/i);
    expect(ok({ shopSectionId: 12 }).shopSectionId).toBe(12);
  });

  test("an attribute can't be cleared from here", () => {
    expect(err({ attributes: [{ propertyId: 200, valueIds: [], values: [] }] })).toMatch(
      /can't be emptied/i,
    );
  });

  test("a variation grid can't be emptied from here", () => {
    expect(err({ variations: { products: [] } })).toMatch(/can't be emptied/i);
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
    ["return policy", { returnPolicyId: 0 }, /valid return policy/i],
    ["processing profile", { readinessStateId: 0 }, /valid processing profile/i],
    ["category", { taxonomyId: 0 }, /valid category/i],
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

describe("About — Etsy requires who, what and when together", () => {
  test("all three together are accepted", () => {
    expect(ok(ABOUT)).toEqual(ABOUT);
  });

  test("one on its own is refused rather than sent as a partial change", () => {
    expect(err({ whoMade: "i_did" })).toMatch(/must be set together/i);
    expect(err({ whoMade: "i_did", whenMade: "made_to_order" })).toMatch(/must be set together/i);
  });

  test("values outside Etsy's enums are refused", () => {
    expect(err({ ...ABOUT, whoMade: "my_cat" })).toMatch(/who made this item/i);
    expect(err({ ...ABOUT, whenMade: "last_tuesday" })).toMatch(/when this item was made/i);
  });

  test("'someone else made it' with no production partner is refused, as Etsy requires", () => {
    expect(
      err({ whoMade: "someone_else", whenMade: "2020_2026", isSupply: false, productionPartnerIds: [] }),
    ).toMatch(/production partner/i);
  });
});

describe("item weight and size", () => {
  test("a weight needs a unit, and the unit must be one Etsy lists", () => {
    expect(ok({ itemWeight: 12, itemWeightUnit: "oz" })).toEqual({
      itemWeight: 12,
      itemWeightUnit: "oz",
    });
    expect(err({ itemWeight: 12 })).toMatch(/unit for the item weight/i);
    expect(err({ itemWeight: 12, itemWeightUnit: "stone" })).toMatch(WEIGHT_UNITS.join(", "));
  });

  test("a size needs a unit too", () => {
    expect(err({ itemLength: 4 })).toMatch(/unit for the item size/i);
    expect(err({ itemLength: 4, itemDimensionsUnit: "parsec" })).toMatch(DIMENSION_UNITS.join(", "));
  });

  test("Etsy requires a measurement above zero, and documents no way to clear one", () => {
    expect(err({ itemWeight: 0, itemWeightUnit: "oz" })).toMatch(/greater than 0/i);
    expect(err({ itemLength: -1, itemDimensionsUnit: "in" })).toMatch(/greater than 0/i);
  });
});

describe("attributes", () => {
  test("value ids and names must line up", () => {
    expect(err({ attributes: [{ propertyId: 200, valueIds: [1, 2], values: ["Red"] }] })).toMatch(
      /matching value ids and names/i,
    );
  });

  test("one property can't appear twice in one edit", () => {
    expect(
      err({
        attributes: [
          { propertyId: 200, valueIds: [1], values: ["Red"] },
          { propertyId: 200, valueIds: [2], values: ["Blue"] },
        ],
      }),
    ).toMatch(/appears twice/i);
  });

  test("a valid attribute keeps its scale", () => {
    expect(ok({ attributes: [{ propertyId: 100, valueIds: [7], values: ["M"], scaleId: 19 }] }).attributes).toEqual(
      [{ propertyId: 100, valueIds: [7], values: ["M"], scaleId: 19 }],
    );
  });

  test("each Optional field resolves to a property by name, not a hard-coded id", () => {
    const properties = [
      { propertyId: 200, name: "primary_color", displayName: "Primary color" },
      { propertyId: 52047899002, name: "size", displayName: "Size" },
    ];
    expect(findAttributeProperty("attr_primary_color", properties)?.propertyId).toBe(200);
    expect(findAttributeProperty("attr_size", properties)?.propertyId).toBe(52047899002);
    // A category without that property simply has none — never a wrong guess.
    expect(findAttributeProperty("attr_neckline", properties)).toBeNull();
  });
});

describe("personalization", () => {
  test("a valid question is accepted", () => {
    const patch = ok({
      personalization: [
        { fieldType: "text_input", questionText: "Name?", required: true, maxAllowedCharacters: 50 },
      ],
    });
    expect(patch.personalization).toHaveLength(1);
    expect(patch.personalization![0]).toMatchObject({ questionText: "Name?", required: true });
  });

  test("Etsy's own field constraints are enforced", () => {
    expect(err({ personalization: [{ fieldType: "text_input", questionText: "" }] })).toMatch(
      /label\/prompt/i,
    );
    expect(err({ personalization: [{ fieldType: "carrier_pigeon" }] })).toMatch(/field type/i);
  });

  test("an empty list is valid — it clears the listing's personalization", () => {
    expect(ok({ personalization: [] }).personalization).toEqual([]);
  });
});

describe("variations", () => {
  const product = {
    propertyValues: [{ propertyId: 200, name: "Color", valueIds: [1], values: ["Red"] }],
    price: 10,
    quantity: 2,
    enabled: true,
  };

  test("a grid is accepted with its on-property lists", () => {
    const patch = ok({ variations: { products: [product], priceOnProperty: [200] } });
    expect(patch.variations!.products).toHaveLength(1);
    expect(patch.variations!.priceOnProperty).toEqual([200]);
  });

  test("a malformed row fails the save rather than being dropped from a live listing", () => {
    expect(
      err({ variations: { products: [{ propertyValues: [{ propertyId: 200, valueIds: [1], values: [] }] }] } }),
    ).toMatch(/value ids or names/i);
    expect(err({ variations: { products: [{ ...product, price: 0 }] } })).toMatch(/greater than 0/i);
  });

  test("a disabled combination is kept — Etsy requires every combination", () => {
    const patch = ok({ variations: { products: [{ ...product, enabled: false }] } });
    expect(patch.variations!.products[0].enabled).toBe(false);
  });
});

describe("splitting a patch across Etsy's separate writes", () => {
  test("each half goes to the call that can write it", () => {
    const { listing, inventory, attributes, personalization, variations } = splitPatch({
      title: "New",
      tags: ["a"],
      materials: ["Cotton"],
      shippingProfileId: 3,
      returnPolicyId: 8,
      itemWeight: 5,
      itemWeightUnit: "oz",
      price: 9.5,
      quantity: 2,
      sku: "SKU-1",
      readinessStateId: 4,
      attributes: [{ propertyId: 200, valueIds: [1], values: ["Red"] }],
      personalization: [],
      variations: null as never,
    });
    expect(listing).toEqual({
      title: "New",
      tags: ["a"],
      materials: ["Cotton"],
      shippingProfileId: 3,
      returnPolicyId: 8,
      itemWeight: 5,
      itemWeightUnit: "oz",
    });
    expect(inventory).toEqual({ price: 9.5, quantity: 2, sku: "SKU-1", readinessStateId: 4 });
    expect(attributes).toHaveLength(1);
    expect(personalization).toEqual([]);
    expect(variations).toBeNull();
  });

  test("a listing-only patch needs no inventory call", () => {
    const { inventory, attributes } = splitPatch({ title: "New" });
    expect(isEmptyPatch(inventory)).toBe(true);
    expect(attributes).toEqual([]);
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
  test("lists the groups the screen is specified to have, in order", () => {
    expect(BULK_GROUPS.map((g) => g.label)).toEqual([
      "AI Edits",
      "Media",
      "Listings",
      "Optional",
      "Inventory",
      "Shipping",
    ]);
  });

  test("AI Edits sits at the top and doesn't collapse; the rest do", () => {
    expect(BULK_GROUPS[0]).toMatchObject({ label: "AI Edits", collapsible: false });
    expect(BULK_GROUPS.slice(1).every((g) => g.collapsible)).toBe(true);
  });

  test("each group lists exactly the fields specified, in order", () => {
    const fieldsOf = (key: string) =>
      BULK_GROUPS.find((g) => g.key === key)!.fields.map((f) => f.label);
    expect(fieldsOf("ai")).toEqual(["Title", "Description", "Tags"]);
    expect(fieldsOf("media")).toEqual(["Photos", "Videos"]);
    expect(fieldsOf("listings")).toEqual([
      "Title",
      "Description",
      "Tags",
      "Materials",
      "About",
      "Production partner",
      "Category",
      "Section",
      "Personalization",
    ]);
    expect(fieldsOf("optional")).toEqual([
      "Primary color",
      "Secondary color",
      "Holiday",
      "Occasion",
      "Materials",
      "Size",
      "Sustainability",
      "Sleeve length",
      "Neckline",
      "Clothing style",
      "Graphic",
    ]);
    expect(fieldsOf("inventory")).toEqual(["Variations", "Price", "Quantity", "SKU"]);
    expect(fieldsOf("shipping")).toEqual([
      "Processing profile",
      "Shipping profile",
      "Item weight",
      "Item size",
      "Return policy",
    ]);
  });

  test("every Optional field is an attribute, and no other field is", () => {
    const optional = BULK_GROUPS.find((g) => g.key === "optional")!.fields.map((f) => f.key);
    expect(optional).toEqual(ATTRIBUTE_FIELDS.map((a) => a.key));
    expect(optional.every(isAttributeField)).toBe(true);
    expect(isAttributeField("title")).toBe(false);
  });

  test("Media is the read-only group — everything else can be written", () => {
    expect(ALL_BULK_FIELDS.filter(isReadOnlyField)).toEqual(["photos", "videos"]);
  });

  test("each field's bulk control matches what it can sensibly apply", () => {
    expect(applyKindFor("title")).toBe("transform");
    expect(applyKindFor("description")).toBe("transform");
    // Tags add to a list; they never overwrite one.
    expect(applyKindFor("tags")).toBe("append");
    expect(applyKindFor("materials")).toBe("append");
    expect(applyKindFor("attr_primary_color")).toBe("select");
    expect(applyKindFor("returnPolicyId")).toBe("select");
    expect(applyKindFor("price")).toBe("value");
    // Edited per listing only.
    expect(applyKindFor("variations")).toBe("none");
    expect(applyKindFor("personalization")).toBe("none");
    expect(applyKindFor("photos")).toBe("none");
  });
});
