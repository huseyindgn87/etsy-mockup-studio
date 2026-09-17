import { describe, expect, test } from "vitest";
import { confirmedListingFields } from "@/lib/etsy/listing-confirmed";

describe("confirmedListingFields", () => {
  test("reads the fields Etsy echoes back after an update", () => {
    const confirmed = confirmedListingFields({
      listing_id: 101,
      title: "Holiday mug",
      description: "A mug",
      tags: ["holiday", "gift", "mug"],
      materials: ["Cotton"],
      who_made: "i_did",
      when_made: "made_to_order",
      is_supply: false,
      taxonomy_id: 1071,
      shop_section_id: 88,
      should_auto_renew: true,
      is_taxable: false,
    });

    expect(confirmed).toMatchObject({
      title: "Holiday mug",
      tags: ["holiday", "gift", "mug"],
      materials: ["Cotton"],
      whoMade: "i_did",
      whenMade: "made_to_order",
      isSupply: false,
      taxonomyId: 1071,
      shopSectionId: 88,
      shouldAutoRenew: true,
      isTaxable: false,
    });
  });

  test("reports the tags Etsy actually stored, not the ones asked for", () => {
    // What a repeated-params write used to leave behind: one tag.
    expect(confirmedListingFields({ listing_id: 101, tags: ["testtag3"] })?.tags).toEqual(["testtag3"]);
  });

  test("leaves out a field the response doesn't carry", () => {
    const confirmed = confirmedListingFields({ listing_id: 101, title: "Only a title" });
    expect(confirmed).toEqual({ title: "Only a title" });
    expect("tags" in confirmed!).toBe(false);
  });

  test("decodes HTML entities the way the listing read does", () => {
    expect(confirmedListingFields({ listing_id: 1, title: "Mum &amp; Dad" })?.title).toBe("Mum & Dad");
  });

  test("maps production partners to their ids", () => {
    const confirmed = confirmedListingFields({
      listing_id: 1,
      production_partners: [{ production_partner_id: 66 }, { production_partner_id: 67 }],
    });
    expect(confirmed?.productionPartnerIds).toEqual([66, 67]);
  });

  test("gives null for anything that isn't a listing", () => {
    expect(confirmedListingFields(null)).toBeNull();
    expect(confirmedListingFields("oops")).toBeNull();
    expect(confirmedListingFields({ error: "nope" })).toBeNull();
  });

  test("a tag list Etsy omits is not reported as empty", () => {
    expect(confirmedListingFields({ listing_id: 1, tags: "holiday,gift" })?.tags).toBeUndefined();
  });
});
