// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import BulkEditor from "../BulkEditor";
import { BULK_GROUPS, MAX_TITLE_LENGTH } from "@/lib/etsy/bulk-edit";
import type { BulkListingDetail } from "../types";

function detail(listingId: number, overrides: Partial<BulkListingDetail> = {}): BulkListingDetail {
  return {
    listingId,
    title: `Listing ${listingId}`,
    description: "",
    tags: [],
    materials: [],
    state: "active",
    url: `https://etsy.com/listing/${listingId}`,
    thumbnailUrl: null,
    shopSectionId: null,
    shippingProfileId: null,
    returnPolicyId: null,
    readinessStateId: null,
    taxonomyId: 1071,
    whoMade: "i_did",
    whenMade: "made_to_order",
    isSupply: false,
    productionPartnerIds: [],
    itemWeight: null,
    itemWeightUnit: null,
    itemLength: null,
    itemWidth: null,
    itemHeight: null,
    itemDimensionsUnit: null,
    shouldAutoRenew: true,
    isTaxable: true,
    price: 10,
    quantity: 3,
    sku: "",
    images: [{ imageId: 1, url: "https://img/1.jpg", rank: 1, altText: "" }],
    videos: [],
    personalizationQuestions: [],
    hasVariations: false,
    ...overrides,
  };
}

const LISTINGS = [detail(101), detail(102), detail(103)];

/** One category's attribute properties, as /api/etsy/taxonomy/{id}/properties returns them. */
const TAXONOMY_PROPERTIES = [
  {
    propertyId: 200,
    name: "primary_color",
    displayName: "Primary color",
    isRequired: false,
    isMultivalued: false,
    maxValuesAllowed: 1,
    supportsAttributes: true,
    supportsVariations: true,
    scales: [],
    possibleValues: [
      { valueId: 1, name: "Red", scaleId: null },
      { valueId: 2, name: "Blue", scaleId: null },
    ],
  },
];

const INVENTORY = {
  listingId: 101,
  properties: [
    {
      propertyId: 200,
      name: "Color",
      scaleId: null,
      options: [
        { valueId: 1, name: "Red" },
        { valueId: 2, name: "Blue" },
      ],
    },
  ],
  combinations: [
    { key: "1", valueIds: [1], values: ["Red"], price: 10, quantity: 2, sku: "R", enabled: true, readinessStateId: null },
    { key: "2", valueIds: [2], values: ["Blue"], price: 12, quantity: 1, sku: "B", enabled: true, readinessStateId: null },
  ],
  priceOnProperty: [200],
  quantityOnProperty: [],
  skuOnProperty: [],
  readinessStateOnProperty: [],
};

let fetchMock: ReturnType<typeof vi.fn>;

function jsonResponse(body: unknown, status = 200) {
  return { ok: status < 400, status, json: async () => body };
}

/** Routes every request the editor makes; bulk saves are recorded for assertions. */
function mockFetch(listings: BulkListingDetail[] = LISTINGS) {
  fetchMock = vi.fn(async (url: string) => {
    if (url.startsWith("/api/etsy/listings/bulk?")) return jsonResponse({ listings, missing: [] });
    if (url.startsWith("/api/etsy/listings/bulk/attributes")) {
      return jsonResponse({
        attributes: { 101: [{ propertyId: 200, propertyName: "Primary color", scaleId: null, valueIds: [1], values: ["Red"] }] },
        missing: [],
      });
    }
    if (url.startsWith("/api/etsy/listings/bulk/inventory")) {
      return jsonResponse({ inventories: { 101: INVENTORY }, missing: [] });
    }
    if (url === "/api/etsy/listings/bulk/save") {
      return jsonResponse({ results: listings.map((l) => ({ listingId: l.listingId, ok: true })) });
    }
    if (url === "/api/etsy/sections") {
      return jsonResponse({ sections: [{ shopSectionId: 9, title: "Mugs" }] });
    }
    if (url === "/api/etsy/shipping-profiles") {
      return jsonResponse({ profiles: [{ shippingProfileId: 44, title: "Standard" }] });
    }
    if (url === "/api/etsy/processing-profiles") {
      return jsonResponse({
        profiles: [
          {
            readinessStateId: 77,
            readinessState: "made_to_order",
            minProcessingDays: 3,
            maxProcessingDays: 5,
            displayLabel: "3 - 5 days",
          },
        ],
      });
    }
    if (url === "/api/etsy/return-policies") {
      return jsonResponse({ policies: [{ returnPolicyId: 55, label: "Returns accepted within 30 days" }] });
    }
    if (url === "/api/etsy/production-partners") {
      return jsonResponse({ partners: [{ productionPartnerId: 66, partnerName: "Printer Co", location: "US" }] });
    }
    if (url === "/api/etsy/taxonomy") {
      return jsonResponse({ tree: [{ id: 1071, name: "Mugs", children: [] }] });
    }
    if (url.startsWith("/api/etsy/taxonomy/")) {
      return jsonResponse({ properties: TAXONOMY_PROPERTIES });
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
}

/** The body of the save request, or null if no save was made. */
function savedUpdates(): { listingId: number; patch: Record<string, unknown> }[] | null {
  const call = fetchMock.mock.calls.find(([url]) => url === "/api/etsy/listings/bulk/save");
  return call ? JSON.parse((call[1] as RequestInit).body as string).updates : null;
}

/**
 * Each row's controls are named for the listing they belong to, so a query
 * can never accidentally reach into the wrong row.
 */
const rowField = (field: string, listing: number) =>
  screen.getByLabelText(`${field} for Listing ${listing}`);
const applyAllField = (field: string) => screen.getByLabelText(`${field} to apply to all`);
const applyButton = () => screen.getByRole("button", { name: "Apply" });
const syncButton = () => screen.getByRole("button", { name: /^Sync updates/ });

/** Title/Description/Tags appear in two groups, so a field is picked by group. */
const openField = (field: string, group: string) =>
  fireEvent.click(screen.getByRole("button", { name: `${field} — ${group}` }));

async function renderEditor(listings: BulkListingDetail[] = LISTINGS) {
  mockFetch(listings);
  render(<BulkEditor listingIds={listings.map((l) => l.listingId)} />);
  await screen.findByText(
    `Editing ${listings.length} listing${listings.length === 1 ? "" : "s"}`,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the screen", () => {
  test("heads with the number of listings being edited", async () => {
    await renderEditor();
    expect(screen.getByText("Editing 3 listings")).toBeInTheDocument();
  });

  test("offers Cancel, Schedule and Sync updates", async () => {
    await renderEditor();
    expect(screen.getByRole("link", { name: "Cancel" })).toHaveAttribute("href", "/listings");
    expect(screen.getByRole("button", { name: "Schedule" })).toBeInTheDocument();
    expect(syncButton()).toBeDisabled(); // nothing changed yet
  });

  test("lists every specified group and field in the sidebar", async () => {
    await renderEditor();
    for (const group of BULK_GROUPS) {
      for (const field of group.fields) {
        expect(
          screen.getByRole("button", { name: `${field.label} — ${group.label}` }),
        ).toBeInTheDocument();
      }
    }
  });

  test("a group collapses and expands", async () => {
    await renderEditor();
    const shipping = screen.getByRole("button", { name: "Shipping" });
    expect(screen.getByRole("button", { name: "Item weight — Shipping" })).toBeInTheDocument();
    fireEvent.click(shipping);
    expect(screen.queryByRole("button", { name: "Item weight — Shipping" })).not.toBeInTheDocument();
    fireEvent.click(shipping);
    expect(screen.getByRole("button", { name: "Item weight — Shipping" })).toBeInTheDocument();
  });
});

describe("every sidebar field renders an editable row control", () => {
  test.each([
    ["Title", "Listings", "Title"],
    ["Description", "Listings", "Description"],
    ["Tags", "Listings", "Tags"],
    ["Materials", "Listings", "Materials"],
    ["Production partner", "Listings", "Production partner"],
    ["Category", "Listings", "Category"],
    ["Section", "Listings", "Section"],
    ["Price", "Inventory", "Price"],
    ["Quantity", "Inventory", "Quantity"],
    ["SKU", "Inventory", "SKU"],
    ["Processing profile", "Shipping", "Processing profile"],
    ["Shipping profile", "Shipping", "Shipping profile"],
    ["Item weight", "Shipping", "Item weight"],
    ["Return policy", "Shipping", "Return policy"],
  ])("%s", async (field, group, rowLabel) => {
    await renderEditor();
    openField(field, group);
    expect(rowField(rowLabel, 101)).toBeInTheDocument();
  });

  test("About edits Etsy's three fields together", async () => {
    await renderEditor();
    openField("About", "Listings");
    expect(rowField("Who made it", 101)).toBeInTheDocument();
    expect(rowField("What is it", 101)).toBeInTheDocument();
    expect(rowField("When was it made", 101)).toBeInTheDocument();
  });

  test("Item size edits all three dimensions and a unit", async () => {
    await renderEditor();
    openField("Item size", "Shipping");
    for (const dimension of ["Item length", "Item width", "Item height", "Item size unit"]) {
      expect(rowField(dimension, 101)).toBeInTheDocument();
    }
  });

  test("Media shows each listing's own images, and never writes them", async () => {
    await renderEditor();
    openField("Photos", "Media");
    expect(screen.getAllByRole("img").length).toBeGreaterThan(0);
    // Read-only: no apply control at all for Media.
    expect(screen.queryByRole("button", { name: "Apply" })).not.toBeInTheDocument();
  });
});

describe("nothing is sent to Etsy until Sync updates is pressed", () => {
  test("typing in a row makes no request at all", async () => {
    await renderEditor();
    openField("Title", "Listings");
    const before = fetchMock.mock.calls.length;
    fireEvent.change(rowField("Title", 101), { target: { value: "Edited in the browser" } });
    expect(fetchMock.mock.calls.length).toBe(before);
    expect(savedUpdates()).toBeNull();
  });

  test("applying a value to every row still sends nothing", async () => {
    await renderEditor();
    openField("Title", "Listings");
    fireEvent.change(applyAllField("Title"), { target: { value: "Everything" } });
    fireEvent.click(applyButton());
    expect(savedUpdates()).toBeNull();
  });

  test("the save request goes out only on the explicit click", async () => {
    await renderEditor();
    openField("Title", "Listings");
    fireEvent.change(rowField("Title", 101), { target: { value: "Renamed" } });
    expect(savedUpdates()).toBeNull();

    fireEvent.click(syncButton());
    await waitFor(() => expect(savedUpdates()).not.toBeNull());
    expect(savedUpdates()).toEqual([{ listingId: 101, patch: { title: "Renamed" } }]);
  });
});

describe("per-row targeting", () => {
  test("a change to one row is written to that row alone", async () => {
    await renderEditor();
    openField("Title", "Listings");
    fireEvent.change(rowField("Title", 102), { target: { value: "Only me" } });
    fireEvent.click(syncButton());
    await waitFor(() => expect(savedUpdates()).not.toBeNull());
    expect(savedUpdates()).toEqual([{ listingId: 102, patch: { title: "Only me" } }]);
  });

  test("independent edits to different fields on different rows survive one save", async () => {
    await renderEditor();
    openField("Title", "Listings");
    fireEvent.change(rowField("Title", 101), { target: { value: "New title" } });

    openField("Tags", "Listings");
    const tagInput = rowField("Tags", 102);
    fireEvent.change(tagInput, { target: { value: "handmade" } });
    fireEvent.keyDown(tagInput, { key: "Enter" });

    openField("Shipping profile", "Shipping");
    fireEvent.change(rowField("Shipping profile", 103), { target: { value: "44" } });

    openField("Return policy", "Shipping");
    fireEvent.change(rowField("Return policy", 103), { target: { value: "55" } });

    fireEvent.click(syncButton());
    await waitFor(() => expect(savedUpdates()).not.toBeNull());
    expect(savedUpdates()).toEqual([
      { listingId: 101, patch: { title: "New title" } },
      { listingId: 102, patch: { tags: ["handmade"] } },
      { listingId: 103, patch: { shippingProfileId: 44, returnPolicyId: 55 } },
    ]);
  });

  test("unticking a row keeps its change out of the save", async () => {
    await renderEditor();
    openField("Title", "Listings");
    fireEvent.change(rowField("Title", 101), { target: { value: "Changed" } });
    fireEvent.change(rowField("Title", 102), { target: { value: "Also changed" } });
    fireEvent.click(screen.getByLabelText("Include Listing 101 in the save"));

    fireEvent.click(syncButton());
    await waitFor(() => expect(savedUpdates()).not.toBeNull());
    expect(savedUpdates()).toEqual([{ listingId: 102, patch: { title: "Also changed" } }]);
  });

  test("a row typed back to its original value contributes nothing", async () => {
    await renderEditor();
    openField("Title", "Listings");
    const input = rowField("Title", 101);
    fireEvent.change(input, { target: { value: "Changed" } });
    fireEvent.change(input, { target: { value: "Listing 101" } });
    expect(syncButton()).toBeDisabled();
  });
});

describe("Apply writes only to ticked rows", () => {
  test("adds text before every ticked row's title", async () => {
    await renderEditor();
    openField("Title", "Listings");
    fireEvent.change(applyAllField("Title"), { target: { value: "Handmade" } });
    fireEvent.click(applyButton());

    for (const id of [101, 102, 103]) {
      expect(rowField("Title", id)).toHaveValue(`Handmade Listing ${id}`);
    }
  });

  test("skips rows the user has unticked", async () => {
    await renderEditor();
    openField("Title", "Listings");
    fireEvent.click(screen.getByLabelText("Include Listing 102 in the save"));
    fireEvent.change(applyAllField("Title"), { target: { value: "Shared" } });
    fireEvent.click(applyButton());

    expect(rowField("Title", 102)).toHaveValue("Listing 102");
    fireEvent.click(syncButton());
    await waitFor(() => expect(savedUpdates()).not.toBeNull());
    expect(savedUpdates()!.map((u) => u.listingId)).toEqual([101, 103]);
  });

  test("find and replace only rewrites the matching part", async () => {
    await renderEditor();
    openField("Title", "Listings");
    fireEvent.change(screen.getByLabelText("Title mode"), { target: { value: "replace" } });
    fireEvent.change(screen.getByLabelText("Title find text"), { target: { value: "Listing" } });
    fireEvent.change(applyAllField("Title"), { target: { value: "Poster" } });
    fireEvent.click(applyButton());

    expect(rowField("Title", 101)).toHaveValue("Poster 101");
  });

  test("a dropdown-backed field applies its chosen Etsy value", async () => {
    await renderEditor();
    openField("Section", "Listings");
    fireEvent.change(applyAllField("Section"), { target: { value: "9" } });
    fireEvent.click(applyButton());

    fireEvent.click(syncButton());
    await waitFor(() => expect(savedUpdates()).not.toBeNull());
    expect(savedUpdates()).toEqual([101, 102, 103].map((listingId) => ({ listingId, patch: { shopSectionId: 9 } })));
  });

  test("a per-row edit after an apply wins for that row", async () => {
    await renderEditor();
    openField("Title", "Listings");
    fireEvent.change(applyAllField("Title"), { target: { value: "Shared" } });
    fireEvent.click(applyButton());
    fireEvent.change(rowField("Title", 102), { target: { value: "Special" } });

    fireEvent.click(syncButton());
    await waitFor(() => expect(savedUpdates()).not.toBeNull());
    expect(savedUpdates()).toEqual([
      { listingId: 101, patch: { title: "Shared Listing 101" } },
      { listingId: 102, patch: { title: "Special" } },
      { listingId: 103, patch: { title: "Shared Listing 103" } },
    ]);
  });
});

describe("tags are added, never replaced", () => {
  const TAGGED = [
    detail(101, { tags: ["gift", "mug"] }),
    detail(102, { tags: ["poster"] }),
  ];

  test("Apply keeps every existing tag and adds the new one", async () => {
    await renderEditor(TAGGED);
    openField("Tags", "Listings");
    fireEvent.change(applyAllField("Tags"), { target: { value: "handmade" } });
    fireEvent.click(applyButton());

    fireEvent.click(syncButton());
    await waitFor(() => expect(savedUpdates()).not.toBeNull());
    expect(savedUpdates()).toEqual([
      { listingId: 101, patch: { tags: ["gift", "mug", "handmade"] } },
      { listingId: 102, patch: { tags: ["poster", "handmade"] } },
    ]);
  });

  test("applying a tag a listing already has leaves it unchanged", async () => {
    await renderEditor(TAGGED);
    openField("Tags", "Listings");
    fireEvent.change(applyAllField("Tags"), { target: { value: "gift" } });
    fireEvent.click(applyButton());

    fireEvent.click(syncButton());
    await waitFor(() => expect(savedUpdates()).not.toBeNull());
    // 101 already had "gift", so only 102 changed at all.
    expect(savedUpdates()).toEqual([{ listingId: 102, patch: { tags: ["poster", "gift"] } }]);
  });

  test("materials are added the same way", async () => {
    await renderEditor([detail(101, { materials: ["cotton"] })]);
    openField("Materials", "Listings");
    fireEvent.change(applyAllField("Materials"), { target: { value: "linen" } });
    fireEvent.click(applyButton());

    fireEvent.click(syncButton());
    await waitFor(() => expect(savedUpdates()).not.toBeNull());
    expect(savedUpdates()).toEqual([{ listingId: 101, patch: { materials: ["cotton", "linen"] } }]);
  });
});

describe("character counters", () => {
  test("the title counter counts down as you type", async () => {
    await renderEditor();
    openField("Title", "Listings");
    const input = rowField("Title", 101);
    const field = input.parentElement!;
    expect(
      within(field).getByText(`${MAX_TITLE_LENGTH - "Listing 101".length} left`),
    ).toBeInTheDocument();

    fireEvent.change(input, { target: { value: "abc" } });
    expect(within(field).getByText(`${MAX_TITLE_LENGTH - 3} left`)).toBeInTheDocument();
  });

  test("the title input can't be typed past Etsy's limit", async () => {
    await renderEditor();
    openField("Title", "Listings");
    expect(rowField("Title", 101)).toHaveAttribute("maxlength", String(MAX_TITLE_LENGTH));
  });

  test("description has no counter — Etsy documents no limit for it", async () => {
    await renderEditor();
    openField("Description", "Listings");
    const field = rowField("Description", 101).closest("label")!;
    expect(within(field).queryByText(/left$/)).not.toBeInTheDocument();
  });

  test("tags show how many of Etsy's 13 are used", async () => {
    await renderEditor();
    openField("Tags", "Listings");
    expect(screen.getAllByText("0/13").length).toBeGreaterThan(0);
  });
});

describe("category rows", () => {
  test("show the full taxonomy path under the title", async () => {
    await renderEditor();
    openField("Category", "Listings");
    await waitFor(() => expect(screen.getAllByText("Mugs").length).toBeGreaterThan(0));
  });
});

describe("Optional attributes", () => {
  test("a row offers only the values its own category has", async () => {
    await renderEditor();
    openField("Primary color", "Optional");
    const select = await screen.findByLabelText("Primary color for Listing 101");
    expect(within(select as HTMLElement).getByRole("option", { name: "Red" })).toBeInTheDocument();
    expect(within(select as HTMLElement).getByRole("option", { name: "Blue" })).toBeInTheDocument();
  });

  test("applying a value writes it as that row's own property value", async () => {
    await renderEditor();
    openField("Primary color", "Optional");
    await screen.findByLabelText("Primary color for Listing 101");
    fireEvent.change(applyAllField("Primary color"), { target: { value: "Blue" } });
    fireEvent.click(applyButton());

    fireEvent.click(syncButton());
    await waitFor(() => expect(savedUpdates()).not.toBeNull());
    expect(savedUpdates()![0].patch).toEqual({
      attributes: [{ propertyId: 200, valueIds: [2], values: ["Blue"], scaleId: null }],
    });
  });

  test("a field the category doesn't have says so instead of offering a dropdown", async () => {
    await renderEditor();
    openField("Neckline", "Optional");
    expect(await screen.findAllByText(/category has no "Neckline" attribute/i)).not.toHaveLength(0);
  });
});

describe("Inventory", () => {
  test("a variation listing says so instead of offering price and quantity", async () => {
    await renderEditor([detail(101), detail(102, { hasVariations: true })]);
    openField("Price", "Inventory");
    expect(rowField("Price", 101)).toBeInTheDocument();
    expect(screen.queryByLabelText("Price for Listing 102")).not.toBeInTheDocument();
    expect(screen.getByText(/Price varies by variation on this listing/i)).toBeInTheDocument();
  });

  test("apply skips it rather than flattening its grid", async () => {
    await renderEditor([detail(101), detail(102, { hasVariations: true })]);
    openField("Price", "Inventory");
    fireEvent.change(applyAllField("Price"), { target: { value: "20" } });
    fireEvent.click(applyButton());

    fireEvent.click(syncButton());
    await waitFor(() => expect(savedUpdates()).not.toBeNull());
    expect(savedUpdates()).toEqual([{ listingId: 101, patch: { price: 20 } }]);
  });

  test("Variations gives each listing its own card of tabs", async () => {
    await renderEditor([detail(101, { hasVariations: true })]);
    openField("Variations", "Inventory");
    for (const tab of ["Variations", "Price", "Quantity", "SKU", "Visibility", "Photos", "Processing"]) {
      expect(await screen.findByLabelText(`${tab} tab for Listing 101`)).toBeInTheDocument();
    }
  });

  test("an option can be added, and the new combination is saved with the grid", async () => {
    await renderEditor([detail(101, { hasVariations: true })]);
    openField("Variations", "Inventory");
    const input = await screen.findByLabelText("Add Color option to Listing 101");
    fireEvent.change(input, { target: { value: "Green" } });
    fireEvent.click(screen.getByRole("button", { name: "Add option" }));

    fireEvent.click(syncButton());
    await waitFor(() => expect(savedUpdates()).not.toBeNull());
    const variations = savedUpdates()![0].patch.variations as { products: unknown[] };
    expect(variations.products).toHaveLength(3);
  });

  test("a per-combination price is edited on its own tab", async () => {
    await renderEditor([detail(101, { hasVariations: true })]);
    openField("Variations", "Inventory");
    fireEvent.click(await screen.findByLabelText("Price tab for Listing 101"));
    fireEvent.change(screen.getByLabelText("Price for Red on Listing 101"), {
      target: { value: "42" },
    });

    fireEvent.click(syncButton());
    await waitFor(() => expect(savedUpdates()).not.toBeNull());
    const variations = savedUpdates()![0].patch.variations as { products: { price?: number }[] };
    expect(variations.products[0].price).toBe(42);
    expect(variations.products[1].price).toBe(12);
  });
});

describe("search", () => {
  test("filters the rows on screen without dropping their pending edits", async () => {
    await renderEditor();
    openField("Title", "Listings");
    fireEvent.change(rowField("Title", 103), { target: { value: "Kept" } });
    fireEvent.change(screen.getByPlaceholderText("Search these listings by title…"), {
      target: { value: "101" },
    });

    expect(screen.queryByLabelText("Title for Listing 103")).not.toBeInTheDocument();
    fireEvent.click(syncButton());
    await waitFor(() => expect(savedUpdates()).not.toBeNull());
    expect(savedUpdates()).toEqual([{ listingId: 103, patch: { title: "Kept" } }]);
  });
});
