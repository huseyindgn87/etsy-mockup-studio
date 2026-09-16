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
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
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
    const mediaSave = /^\/api\/etsy\/listings\/(\d+)\/media$/.exec(url);
    if (mediaSave) {
      const listing = listings.find((l) => l.listingId === Number(mediaSave[1]))!;
      const { images } = JSON.parse(((init as RequestInit).body as FormData).get("payload") as string) as {
        images: { kind: string; imageId?: number; altText: string }[];
      };
      return jsonResponse({
        ok: true,
        failed: [],
        images: images.map((entry, i) => ({
          imageId: entry.imageId ?? 9000 + i,
          url: `https://img/${entry.imageId ?? 9000 + i}.jpg`,
          rank: i + 1,
          altText: entry.altText,
        })),
        videos: listing.videos,
      });
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

  test("Media shows each listing's own images as editable tiles", async () => {
    await renderEditor();
    openField("Photos", "Media");
    expect(within(row(101)).getByRole("button", { name: "Remove photo 1" })).toBeInTheDocument();
    expect(within(row(101)).getByRole("button", { name: "Alt text for photo 1" })).toBeInTheDocument();
    expect(within(row(101)).getByRole("button", { name: "Upload your own" })).toBeInTheDocument();
    // Edited per listing: no apply-to-all control for Media.
    expect(screen.queryByRole("button", { name: "Apply" })).not.toBeInTheDocument();
  });
});

/** One listing's row — every media control is looked up inside it. */
const row = (listingId: number) => screen.getByRole("group", { name: `Listing ${listingId}` });

/** Every media save made so far: listing id, the order it sent, and its files. */
function mediaSaves() {
  return fetchMock.mock.calls
    .filter(([url]) => /^\/api\/etsy\/listings\/\d+\/media$/.test(url))
    .map(([url, init]) => {
      const body = (init as RequestInit).body as FormData;
      return {
        listingId: Number(/listings\/(\d+)\/media/.exec(url)![1]),
        ...(JSON.parse(body.get("payload") as string) as {
          images: { kind: string; imageId?: number; index?: number; altText: string }[];
          videos: { kind: string; videoId?: number; index?: number }[];
        }),
        imageFiles: body.getAll("image") as File[],
      };
    });
}

const tileNames = (listingId: number) =>
  within(within(row(listingId)).getByRole("list", { name: "Listing photos" }))
    .getAllByRole("img")
    .map((img) => img.getAttribute("src"));

function dragTile(listingId: number, from: number, to: number) {
  const tiles = within(row(listingId)).getAllByRole("listitem", { name: /^Photo \d+:/ });
  fireEvent.dragStart(tiles[from]);
  fireEvent.dragOver(tiles[to]);
  fireEvent.drop(tiles[to]);
  fireEvent.dragEnd(tiles[from]);
}

const threePhotos = (listingId: number) =>
  [1, 2, 3].map((n) => ({
    imageId: listingId * 10 + n,
    url: `https://img/${listingId * 10 + n}.jpg`,
    rank: n,
    altText: n === 1 ? "Front" : "",
  }));

const MEDIA_LISTINGS = [
  detail(101, { images: threePhotos(101) }),
  detail(102, {
    images: threePhotos(102),
    videos: [
      { videoId: 71, thumbnailUrl: "", videoUrl: "https://vid/71.mp4", state: "active" },
      { videoId: 72, thumbnailUrl: "", videoUrl: "https://vid/72.mp4", state: "active" },
    ],
  }),
  detail(103, { images: threePhotos(103) }),
];

describe("Media tiles on each row", () => {
  test("reordering sends nothing until Sync updates, then persists that row's new order", async () => {
    await renderEditor(MEDIA_LISTINGS);
    openField("Photos", "Media");
    dragTile(101, 2, 0);
    expect(tileNames(101)).toEqual(["https://img/1013.jpg", "https://img/1011.jpg", "https://img/1012.jpg"]);
    expect(mediaSaves()).toEqual([]);
    expect(syncButton()).toHaveTextContent("Sync updates (1)");

    fireEvent.click(syncButton());
    await waitFor(() => expect(mediaSaves()).toHaveLength(1));
    expect(mediaSaves()[0]).toMatchObject({
      listingId: 101,
      images: [
        { kind: "existing", imageId: 1013, altText: "" },
        { kind: "existing", imageId: 1011, altText: "Front" },
        { kind: "existing", imageId: 1012, altText: "" },
      ],
    });
    expect(savedUpdates()).toBeNull();
    await waitFor(() => expect(syncButton()).toBeDisabled());
    expect(tileNames(101)).toEqual(["https://img/1013.jpg", "https://img/1011.jpg", "https://img/1012.jpg"]);
  });

  test("keyboard move left/right reorders a row's tiles", async () => {
    await renderEditor(MEDIA_LISTINGS);
    openField("Photos", "Media");
    fireEvent.click(within(row(103)).getByRole("button", { name: "Move photo 1 right" }));
    expect(tileNames(103)).toEqual(["https://img/1032.jpg", "https://img/1031.jpg", "https://img/1033.jpg"]);
  });

  test("alt text saves to the right image of the right listing", async () => {
    await renderEditor(MEDIA_LISTINGS);
    openField("Photos", "Media");
    fireEvent.click(within(row(102)).getByRole("button", { name: "Alt text for photo 2" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByRole("textbox")).toHaveFocus();
    fireEvent.change(within(dialog).getByRole("textbox"), { target: { value: "Mug on a desk" } });
    expect(within(dialog).getByText("487 characters remaining")).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    expect(within(row(102)).getByRole("button", { name: "Alt text for photo 2" })).toHaveAttribute("data-state", "filled");
    expect(within(row(101)).getByRole("button", { name: "Alt text for photo 2" })).toHaveAttribute("data-state", "empty");

    fireEvent.click(syncButton());
    await waitFor(() => expect(mediaSaves()).toHaveLength(1));
    expect(mediaSaves()[0].listingId).toBe(102);
    expect(mediaSaves()[0].images).toEqual([
      { kind: "existing", imageId: 1021, altText: "Front" },
      { kind: "existing", imageId: 1022, altText: "Mug on a desk" },
      { kind: "existing", imageId: 1023, altText: "" },
    ]);
  });

  test("remove clears exactly the clicked tile of that row", async () => {
    await renderEditor(MEDIA_LISTINGS);
    openField("Photos", "Media");
    fireEvent.click(within(row(103)).getByRole("button", { name: "Remove photo 2" }));
    expect(tileNames(103)).toEqual(["https://img/1031.jpg", "https://img/1033.jpg"]);
    expect(tileNames(101)).toHaveLength(3);

    fireEvent.click(syncButton());
    await waitFor(() => expect(mediaSaves()).toHaveLength(1));
    expect(mediaSaves()[0]).toMatchObject({
      listingId: 103,
      images: [
        { kind: "existing", imageId: 1031 },
        { kind: "existing", imageId: 1033 },
      ],
    });
  });

  test("editing one listing's photos never touches another's", async () => {
    await renderEditor(MEDIA_LISTINGS);
    openField("Photos", "Media");
    dragTile(101, 0, 2);
    fireEvent.click(within(row(101)).getByRole("button", { name: "Remove photo 1" }));

    expect(tileNames(102)).toEqual(["https://img/1021.jpg", "https://img/1022.jpg", "https://img/1023.jpg"]);
    expect(tileNames(103)).toEqual(["https://img/1031.jpg", "https://img/1032.jpg", "https://img/1033.jpg"]);
    expect(syncButton()).toHaveTextContent("Sync updates (1)");

    fireEvent.click(syncButton());
    await waitFor(() => expect(mediaSaves()).toHaveLength(1));
    expect(mediaSaves().map((m) => m.listingId)).toEqual([101]);
  });

  test("an unticked row's media is left out of the save", async () => {
    await renderEditor(MEDIA_LISTINGS);
    openField("Photos", "Media");
    fireEvent.click(within(row(101)).getByRole("button", { name: "Remove photo 3" }));
    fireEvent.click(within(row(102)).getByRole("button", { name: "Remove photo 3" }));
    fireEvent.click(screen.getByLabelText("Include Listing 101 in the save"));

    fireEvent.click(syncButton());
    await waitFor(() => expect(mediaSaves()).toHaveLength(1));
    expect(mediaSaves()[0].listingId).toBe(102);
  });

  test("a new photo from an empty slot's file picker is sent with that row only", async () => {
    await renderEditor(MEDIA_LISTINGS);
    openField("Photos", "Media");
    URL.createObjectURL = vi.fn(() => "blob:new");
    URL.revokeObjectURL = vi.fn();
    const input = row(102).querySelector<HTMLInputElement>('[data-testid="photo-file-input"]')!;
    const click = vi.spyOn(input, "click");
    fireEvent.click(within(row(102)).getByRole("button", { name: "Add a photo to slot 4" }));
    expect(click).toHaveBeenCalledTimes(1);
    const file = new File(["x"], "added.jpg", { type: "image/jpeg" });
    fireEvent.change(input, { target: { files: [file] } });
    expect(tileNames(102)).toHaveLength(4);

    fireEvent.click(syncButton());
    await waitFor(() => expect(mediaSaves()).toHaveLength(1));
    const [saved] = mediaSaves();
    expect(saved.listingId).toBe(102);
    expect(saved.images.at(-1)).toEqual({ kind: "new", index: 0, altText: "" });
    expect(saved.imageFiles.map((f) => f.name)).toEqual(["added.jpg"]);
  });

  test("video tiles reorder and remove per row, with no alt text button", async () => {
    await renderEditor(MEDIA_LISTINGS);
    openField("Videos", "Media");
    const videos = within(row(102)).getByRole("list", { name: "Listing videos" });
    expect(within(videos).queryByRole("button", { name: /alt text/i })).not.toBeInTheDocument();
    expect(within(row(101)).getByRole("button", { name: "Upload a video to slot 1" })).toBeInTheDocument();

    fireEvent.click(within(row(102)).getByRole("button", { name: "Move video 1 right" }));
    fireEvent.click(syncButton());
    await waitFor(() => expect(mediaSaves()).toHaveLength(1));
    expect(mediaSaves()[0]).toMatchObject({
      listingId: 102,
      videos: [
        { kind: "existing", videoId: 72 },
        { kind: "existing", videoId: 71 },
      ],
    });
  });

  test("removing a video tile leaves an empty plus slot and saves without it", async () => {
    await renderEditor(MEDIA_LISTINGS);
    openField("Videos", "Media");
    fireEvent.click(within(row(102)).getByRole("button", { name: "Remove video 1" }));
    expect(within(row(102)).getByRole("button", { name: "Upload a video to slot 1" })).toBeInTheDocument();

    fireEvent.click(syncButton());
    await waitFor(() => expect(mediaSaves()).toHaveLength(1));
    expect(mediaSaves()[0].videos).toEqual([{ kind: "existing", videoId: 72 }]);
  });

  test("field edits and media edits on different rows go out in one Sync", async () => {
    await renderEditor(MEDIA_LISTINGS);
    openField("Title", "Listings");
    fireEvent.change(rowField("Title", 101), { target: { value: "Renamed" } });
    openField("Photos", "Media");
    fireEvent.click(within(row(103)).getByRole("button", { name: "Remove photo 1" }));
    expect(syncButton()).toHaveTextContent("Sync updates (2)");

    fireEvent.click(syncButton());
    await waitFor(() => expect(mediaSaves()).toHaveLength(1));
    expect(savedUpdates()).toEqual([{ listingId: 101, patch: { title: "Renamed" } }]);
    expect(mediaSaves()[0].listingId).toBe(103);
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

describe("leaving with unsaved edits", () => {
  const reload = () => {
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    return event;
  };

  /** Stops the Cancel link's own navigation (no app router in tests) and records whether the click got that far. */
  function sinkCancel() {
    const cancel = screen.getByRole("link", { name: "Cancel" });
    const reached = vi.fn();
    cancel.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      reached();
    });
    return { cancel, reached };
  }

  test("nothing edited: Cancel and reload aren't warned about", async () => {
    await renderEditor();
    const { cancel, reached } = sinkCancel();
    fireEvent.click(cancel);
    expect(reached).toHaveBeenCalled();
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(reload().defaultPrevented).toBe(false);
  });

  test("pending edits hold Cancel with a dialog naming how many listings, and warn on reload", async () => {
    await renderEditor();
    openField("Title", "Listings");
    fireEvent.change(rowField("Title", 101), { target: { value: "Changed" } });
    fireEvent.change(rowField("Title", 102), { target: { value: "Changed too" } });

    const { cancel, reached } = sinkCancel();
    fireEvent.click(cancel);
    expect(reached).not.toHaveBeenCalled();
    expect(screen.getByRole("alertdialog")).toHaveTextContent("2 listings have unsaved changes");
    expect(reload().defaultPrevented).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Stay" }));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(rowField("Title", 101)).toHaveValue("Changed");

    fireEvent.click(cancel);
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect(reached).toHaveBeenCalledTimes(1);
  });

  test("no warning right after a successful Sync updates", async () => {
    await renderEditor();
    openField("Title", "Listings");
    fireEvent.change(rowField("Title", 101), { target: { value: "Saved title" } });
    expect(reload().defaultPrevented).toBe(true);

    fireEvent.click(syncButton());
    await waitFor(() => expect(syncButton()).toHaveTextContent(/^Sync updates$/));
    expect(reload().defaultPrevented).toBe(false);
    const { cancel, reached } = sinkCancel();
    fireEvent.click(cancel);
    expect(reached).toHaveBeenCalled();
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });
});
