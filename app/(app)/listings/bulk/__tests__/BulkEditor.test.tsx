// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
/** What the save route answers, per request; defaults to every listing saved. */
let saveResults:
  | ((updates: { listingId: number }[]) => { listingId: number; ok: boolean; partial?: boolean; error?: string }[])
  | null = null;
/** Held before a listing's save answers, so a test can keep a write in flight. */
let saveDelay: ((listingId: number) => Promise<void>) | null = null;
/** What AI Edits answers for one request body. */
let aiAnswer: (body: { field: string; listing: { title: string } }) => { status: number; body: unknown } = (body) => ({
  status: 200,
  body: { value: body.field === "tags" ? ["ai tag", "second tag"] : `AI ${body.listing.title}` },
});

/** Whether the schedule's file uploads answer or report that R2 is missing. */
let storageConfigured = true;

/** Each listing's variation photos as the inventory read returns them; undefined = Etsy didn't return them. */
let variationImagesFor: (listingId: number) => { propertyId: number; valueId: number; value: string; imageId: number }[] | undefined =
  () => [];

/** Listing 101's grid, re-keyed for any listing id. */
const inventoryFor = (listingId: number) => ({ ...INVENTORY, listingId });

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
      const ids = new URL(url, "http://x").searchParams.get("ids")!.split(",").map(Number);
      const variationImages = Object.fromEntries(
        ids.flatMap((id) => {
          const images = variationImagesFor(id);
          return images ? [[id, images]] : [];
        }),
      );
      return jsonResponse({
        inventories: Object.fromEntries(ids.map((id) => [id, inventoryFor(id)])),
        variationImages,
        missing: [],
      });
    }
    if (url === "/api/etsy/shop") return jsonResponse({ shopName: "GHCollectiveUS", currencyCode: "USD" });
    if (url === "/api/ai/optimize") {
      const answer = aiAnswer(JSON.parse((init as RequestInit).body as string));
      return jsonResponse(answer.body, answer.status);
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
      const { updates } = JSON.parse((init as RequestInit).body as string) as { updates: { listingId: number }[] };
      if (saveDelay) await saveDelay(updates[0].listingId);
      return jsonResponse({
        results: saveResults ? saveResults(updates) : updates.map((u) => ({ listingId: u.listingId, ok: true })),
      });
    }
    if (url === "/api/schedule") {
      return jsonResponse({ scheduledListing: { id: "sched-1", scheduledAt: "2026-09-20T14:30:00.000Z" } }, 201);
    }
    const renderUpload = /^\/api\/schedule\/renders\/([^/]+)\/([^/]+)$/.exec(url);
    if (renderUpload) {
      if (!storageConfigured) return jsonResponse({ error: "File storage (R2) isn't set up yet." }, 503);
      return jsonResponse({ ok: true, key: `scheduled/alice/${renderUpload[1]}/${renderUpload[2]}` });
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

/**
 * Every listing sent to the save route, in order — a Sync sends one request
 * per listing, so this flattens them. Null if no save was made.
 */
function savedUpdates(): { listingId: number; patch: Record<string, unknown> }[] | null {
  const saves = allSaves();
  return saves.length > 0 ? saves.flat() : null;
}

/** Every save request body, in order — one per listing written. */
const allSaves = (): { listingId: number; patch: Record<string, unknown> }[][] =>
  fetchMock.mock.calls
    .filter(([url]) => url === "/api/etsy/listings/bulk/save")
    .map(([, init]) => JSON.parse((init as RequestInit).body as string).updates);

/** Every scheduled-edit request body, in order. */
const scheduleCalls = () =>
  fetchMock.mock.calls
    .filter(([url]) => url === "/api/schedule")
    .map(([, init]) => JSON.parse((init as RequestInit).body as string));

const aiCalls = () =>
  fetchMock.mock.calls
    .filter(([url]) => url === "/api/ai/optimize")
    .map(([, init]) => JSON.parse((init as RequestInit).body as string));

const inRow = (listing: number) => within(screen.getByRole("group", { name: `Listing ${listing}` }));

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

/** A promise a test resolves when it wants a held request to answer. */
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

beforeEach(() => {
  vi.clearAllMocks();
  saveResults = null;
  saveDelay = null;
  storageConfigured = true;
  variationImagesFor = () => [];
  aiAnswer = (body) => ({
    status: 200,
    body: { value: body.field === "tags" ? ["ai tag", "second tag"] : `AI ${body.listing.title}` },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
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

describe("Inventory — variation blocks", () => {
  const VARIED = [detail(101), detail(102, { hasVariations: true }), detail(103, { hasVariations: true })];

  test("a plain listing keeps its single control; a variation listing shows its own collapsed block", async () => {
    await renderEditor(VARIED);
    openField("Price", "Inventory");
    expect(rowField("Price", 101)).toHaveValue(10);
    const block = await inRow(102).findByRole("button", { name: "Show all variations for Listing 102" });
    expect(block).toHaveAttribute("aria-expanded", "false");
    expect(inRow(102).getByText("Red — 10.00")).toBeInTheDocument();
    expect(inRow(102).queryByRole("tablist")).not.toBeInTheDocument();
    expect(inRow(101).queryByRole("button", { name: /Show all variations/ })).not.toBeInTheDocument();
  });

  test("each listing's block expands and collapses on its own, mounting its table only when expanded", async () => {
    await renderEditor(VARIED);
    openField("Price", "Inventory");
    fireEvent.click(await inRow(102).findByRole("button", { name: "Show all variations for Listing 102" }));

    const tabs102 = inRow(102).getByRole("tablist", { name: "Variation details for Listing 102" });
    expect(within(tabs102).getByRole("tab", { name: "Price" })).toHaveAttribute("aria-selected", "true");
    for (const tab of ["Variations", "Price", "Quantity", "SKU", "Visibility", "Photos", "Processing"]) {
      expect(within(tabs102).getByRole("tab", { name: tab })).toBeInTheDocument();
    }
    expect(inRow(102).getByLabelText("Price for Red")).toHaveValue("10.00");
    expect(inRow(103).queryByRole("tablist")).not.toBeInTheDocument();
    expect(inRow(103).queryByLabelText("Price for Red")).not.toBeInTheDocument();

    fireEvent.click(inRow(103).getByRole("button", { name: "Show all variations for Listing 103" }));
    fireEvent.click(inRow(102).getByRole("button", { name: "Show less variations for Listing 102" }));
    expect(inRow(102).queryByRole("tablist")).not.toBeInTheDocument();
    expect(inRow(103).getByRole("tablist")).toBeInTheDocument();
  });

  test("editing one listing's combination price never touches another listing's grid", async () => {
    await renderEditor(VARIED);
    openField("Price", "Inventory");
    fireEvent.click(await inRow(102).findByRole("button", { name: "Show all variations for Listing 102" }));
    fireEvent.click(inRow(103).getByRole("button", { name: "Show all variations for Listing 103" }));
    fireEvent.change(inRow(102).getByLabelText("Price for Red"), { target: { value: "42" } });

    expect(inRow(103).getByLabelText("Price for Red")).toHaveValue("10.00");
    fireEvent.click(syncButton());
    await waitFor(() => expect(savedUpdates()).not.toBeNull());
    const updates = savedUpdates()!;
    expect(updates.map((u) => u.listingId)).toEqual([102]);
    const variations = updates[0].patch.variations as { products: { price?: number }[]; priceOnProperty: number[] };
    expect(variations.products.map((p) => p.price)).toEqual([42, 12]);
    expect(variations.priceOnProperty).toEqual([200]);
  });

  test("Price's bulk bar reaches ticked plain listings and ticked variation grids, never unticked ones", async () => {
    await renderEditor(VARIED);
    openField("Price", "Inventory");
    await inRow(103).findByRole("button", { name: "Show all variations for Listing 103" });
    fireEvent.click(screen.getByLabelText("Include Listing 103 in the save"));

    expect(applyButton()).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Price operation"), { target: { value: "increase" } });
    fireEvent.click(screen.getByRole("button", { name: "Amount as a percentage" }));
    fireEvent.change(applyAllField("Price"), { target: { value: "10" } });
    fireEvent.click(applyButton());

    expect(rowField("Price", 101)).toHaveValue(11);
    expect(inRow(102).getByText("Blue — 13.20")).toBeInTheDocument();
    expect(inRow(103).getByText("Blue — 12.00")).toBeInTheDocument();

    fireEvent.click(syncButton());
    await waitFor(() => expect(savedUpdates()).not.toBeNull());
    const updates = savedUpdates()!;
    expect(updates.map((u) => u.listingId)).toEqual([101, 102]);
    expect(updates[0].patch).toEqual({ price: 11 });
    expect((updates[1].patch.variations as { products: { price: number }[] }).products.map((p) => p.price)).toEqual([
      11, 13.2,
    ]);
  });

  test("a percentage can't be chosen for Set to", async () => {
    await renderEditor();
    openField("Price", "Inventory");
    expect(screen.getByRole("button", { name: "Amount as a percentage" })).toBeDisabled();
    fireEvent.change(applyAllField("Price"), { target: { value: "12.5" } });
    fireEvent.click(applyButton());
    expect(rowField("Price", 102)).toHaveValue(12.5);
  });

  test("SKU's bar adds text before each ticked row's SKU", async () => {
    await renderEditor([detail(101, { sku: "MUG-1" }), detail(102, { sku: "MUG-2" })]);
    openField("SKU", "Inventory");
    fireEvent.change(applyAllField("SKU"), { target: { value: "GH-" } });
    fireEvent.click(applyButton());
    expect(rowField("SKU", 101)).toHaveValue("GH-MUG-1");
    expect(rowField("SKU", 102)).toHaveValue("GH-MUG-2");
  });

  test("an option added on the Variations tab saves the whole new grid", async () => {
    await renderEditor([detail(101, { hasVariations: true })]);
    openField("Variations", "Inventory");
    fireEvent.click(await inRow(101).findByRole("button", { name: "Show all variations for Listing 101" }));
    fireEvent.change(await inRow(101).findByLabelText("New Color option"), { target: { value: "Green" } });
    fireEvent.click(inRow(101).getByRole("button", { name: "Add Color option" }));

    fireEvent.click(syncButton());
    await waitFor(() => expect(savedUpdates()).not.toBeNull());
    const variations = savedUpdates()![0].patch.variations as {
      products: { propertyValues: { valueIds: (number | null)[]; values: string[] }[]; price: number }[];
    };
    expect(variations.products).toHaveLength(3);
    expect(variations.products[2].propertyValues[0]).toMatchObject({ valueIds: [null], values: ["Green"] });
  });
});

describe("Inventory — variation photos", () => {
  const PHOTOS = [
    { imageId: 1, url: "https://img/1.jpg", rank: 1, altText: "" },
    { imageId: 2, url: "https://img/2.jpg", rank: 2, altText: "" },
  ];
  const VARIED = [detail(101, { hasVariations: true, images: PHOTOS })];

  async function openPhotos() {
    await renderEditor(VARIED);
    openField("Variations", "Inventory");
    fireEvent.click(await inRow(101).findByRole("button", { name: "Show all variations for Listing 101" }));
    fireEvent.click(inRow(101).getByRole("tab", { name: "Photos" }));
  }

  test("a photo picked for an option is sent as the listing's full set, without resending the grid", async () => {
    await openPhotos();
    fireEvent.change(inRow(101).getByLabelText("Photos vary by"), { target: { value: "0" } });
    fireEvent.click(inRow(101).getByRole("button", { name: "Photo 2 for Blue" }));

    fireEvent.click(syncButton());
    await waitFor(() => expect(savedUpdates()).not.toBeNull());
    expect(savedUpdates()).toEqual([
      { listingId: 101, patch: { variationImages: [{ propertyId: 200, valueId: 2, value: "Blue", imageId: 2 }] } },
    ]);
  });

  test("the listing's current photos load into the tab, and clearing one sends the cleared set", async () => {
    variationImagesFor = () => [{ propertyId: 200, valueId: 1, value: "Red", imageId: 1 }];
    await openPhotos();
    expect(inRow(101).getByRole("button", { name: "Photo 1 for Red" })).toHaveAttribute("aria-pressed", "true");
    expect(syncButton()).toHaveTextContent(/^Sync updates$/);

    fireEvent.click(inRow(101).getByRole("button", { name: "No photo for Red" }));
    fireEvent.click(syncButton());
    await waitFor(() => expect(savedUpdates()).not.toBeNull());
    expect(savedUpdates()).toEqual([{ listingId: 101, patch: { variationImages: [] } }]);
  });

  test("a partial save keeps the photo selections, and the next Sync sends only them", async () => {
    await openPhotos();
    fireEvent.change(inRow(101).getByLabelText("Photos vary by"), { target: { value: "0" } });
    fireEvent.click(inRow(101).getByRole("button", { name: "Photo 1 for Red" }));
    fireEvent.click(inRow(101).getByRole("tab", { name: "Price" }));
    fireEvent.change(inRow(101).getByLabelText("Price for Red"), { target: { value: "42" } });
    saveResults = (updates) =>
      updates.map((u) => ({ listingId: u.listingId, ok: false, partial: true, error: "Variation photos: Etsy said no." }));

    fireEvent.click(syncButton());
    await screen.findByText(/1 partly saved/);
    expect(allSaves()[0][0].patch).toHaveProperty("variations");
    expect(inRow(101).getByText(/Partly saved\. Variation photos: Etsy said no\./)).toBeInTheDocument();
    fireEvent.click(inRow(101).getByRole("tab", { name: "Photos" }));
    expect(inRow(101).getByRole("button", { name: "Photo 1 for Red" })).toHaveAttribute("aria-pressed", "true");

    saveResults = null;
    fireEvent.click(syncButton());
    await waitFor(() => expect(allSaves()).toHaveLength(2));
    expect(allSaves()[1]).toEqual([
      { listingId: 101, patch: { variationImages: [{ propertyId: 200, valueId: 1, value: "Red", imageId: 1 }] } },
    ]);
  });

  test("photos a media edit is saving go out before the variation photos that may name them", async () => {
    await openPhotos();
    fireEvent.change(inRow(101).getByLabelText("Photos vary by"), { target: { value: "0" } });
    fireEvent.click(inRow(101).getByRole("button", { name: "Photo 2 for Red" }));
    openField("Photos", "Media");
    dragTile(101, 1, 0);

    fireEvent.click(syncButton());
    await waitFor(() => expect(savedUpdates()).not.toBeNull());
    const urls = fetchMock.mock.calls.map(([url]) => url as string);
    expect(urls.indexOf("/api/etsy/listings/101/media")).toBeGreaterThanOrEqual(0);
    expect(urls.indexOf("/api/etsy/listings/101/media")).toBeLessThan(urls.indexOf("/api/etsy/listings/bulk/save"));
  });

  test("photos Etsy didn't return can't be changed from the block", async () => {
    variationImagesFor = () => undefined;
    await openPhotos();
    expect(inRow(101).getByText(/didn't return this listing's variation photos/)).toBeInTheDocument();
    expect(inRow(101).queryByLabelText("Photos vary by")).not.toBeInTheDocument();
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

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
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

  test("the browser Back button is held while edits are pending", async () => {
    await renderEditor();
    const go = vi.spyOn(window.history, "go").mockImplementation(() => {});
    openField("Title", "Listings");
    fireEvent.change(rowField("Title", 101), { target: { value: "Changed" } });

    await act(async () => {
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(screen.getByRole("alertdialog")).toHaveTextContent("1 listing has unsaved changes");
    expect(go).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect(go).toHaveBeenCalledWith(-2);
    go.mockRestore();
  });

  test("Sync updates and leave writes the edits, then carries on", async () => {
    await renderEditor();
    openField("Title", "Listings");
    fireEvent.change(rowField("Title", 101), { target: { value: "Saved on the way out" } });

    const { cancel, reached } = sinkCancel();
    fireEvent.click(cancel);
    fireEvent.click(screen.getByRole("button", { name: "Sync updates and leave" }));

    await waitFor(() => expect(reached).toHaveBeenCalledTimes(1));
    expect(savedUpdates()).toEqual([{ listingId: 101, patch: { title: "Saved on the way out" } }]);
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });
});

describe("selection", () => {
  test("the master checkbox ticks and unticks only the rows the search shows", async () => {
    await renderEditor();
    const master = screen.getByRole("checkbox", { name: "Select all listings" });
    expect(master).toBeChecked();

    fireEvent.change(screen.getByPlaceholderText("Search these listings by title…"), { target: { value: "101" } });
    expect(screen.getAllByRole("group", { name: /^Listing \d+$/ })).toHaveLength(1);
    fireEvent.click(master);
    fireEvent.change(screen.getByPlaceholderText("Search these listings by title…"), { target: { value: "" } });

    expect(screen.getByLabelText("Include Listing 101 in the save")).not.toBeChecked();
    expect(screen.getByLabelText("Include Listing 102 in the save")).toBeChecked();
    expect(screen.getByLabelText("Include Listing 103 in the save")).toBeChecked();
    expect(master).not.toBeChecked();
    expect((master as HTMLInputElement).indeterminate).toBe(true);
  });
});

describe("AI Edits", () => {
  test("Optimize stays disabled until a preset or prompt is set, then fills every ticked row", async () => {
    await renderEditor();
    openField("Title", "AI Edits");
    const optimize = screen.getByRole("button", { name: "Optimize" });
    expect(optimize).toBeDisabled();
    expect(screen.getByRole("button", { name: "Regenerate title for Listing 101" })).toBeDisabled();

    fireEvent.click(screen.getByLabelText("Include Listing 102 in the save"));
    fireEvent.change(screen.getByLabelText("Prompt preset"), { target: { value: "seo" } });
    fireEvent.click(optimize);

    await waitFor(() => expect(rowField("Title", 103)).toHaveValue("AI Listing 103"));
    expect(rowField("Title", 101)).toHaveValue("AI Listing 101");
    expect(rowField("Title", 102)).toHaveValue("Listing 102");
    expect(aiCalls().map((c) => c.listing.title).sort()).toEqual(["Listing 101", "Listing 103"]);
    expect(aiCalls()[0]).toMatchObject({ field: "title", preset: "seo", model: "claude-opus-5" });
    expect(savedUpdates()).toBeNull();
  });

  test("a row's Regenerate rewrites that row alone, with the bar's prompt and model", async () => {
    await renderEditor();
    openField("Description", "AI Edits");
    fireEvent.change(screen.getByLabelText("AI prompt"), { target: { value: "Mention it's dishwasher safe" } });
    fireEvent.change(screen.getByLabelText("Model"), { target: { value: "claude-sonnet-5" } });
    fireEvent.click(screen.getByRole("button", { name: "Regenerate description for Listing 102" }));

    await waitFor(() => expect(rowField("Description", 102)).toHaveValue("AI Listing 102"));
    expect(rowField("Description", 101)).toHaveValue("");
    expect(aiCalls()).toEqual([
      {
        field: "description",
        model: "claude-sonnet-5",
        preset: "",
        prompt: "Mention it's dishwasher safe",
        listing: { title: "Listing 102", description: "", tags: [] },
      },
    ]);

    fireEvent.click(syncButton());
    await waitFor(() => expect(savedUpdates()).not.toBeNull());
    expect(savedUpdates()).toEqual([{ listingId: 102, patch: { description: "AI Listing 102" } }]);
  });

  test("regenerated tags replace that row's tag list", async () => {
    await renderEditor([detail(101, { tags: ["old"] })]);
    openField("Tags", "AI Edits");
    fireEvent.change(screen.getByLabelText("Prompt preset"), { target: { value: "gift" } });
    fireEvent.click(screen.getByRole("button", { name: "Regenerate tags for Listing 101" }));
    await waitFor(() => expect(inRow(101).getByText("ai tag")).toBeInTheDocument());
    fireEvent.click(syncButton());
    await waitFor(() => expect(savedUpdates()).not.toBeNull());
    expect(savedUpdates()).toEqual([{ listingId: 101, patch: { tags: ["ai tag", "second tag"] } }]);
  });

  test("a failed regenerate is reported on its own row and leaves the value alone", async () => {
    aiAnswer = () => ({ status: 503, body: { error: "AI Edits isn't set up." } });
    await renderEditor();
    openField("Title", "AI Edits");
    fireEvent.change(screen.getByLabelText("Prompt preset"), { target: { value: "shorten" } });
    fireEvent.click(screen.getByRole("button", { name: "Regenerate title for Listing 103" }));

    expect(await inRow(103).findByRole("alert")).toHaveTextContent("AI Edits isn't set up.");
    expect(rowField("Title", 103)).toHaveValue("Listing 103");
    expect(inRow(101).queryByRole("alert")).not.toBeInTheDocument();
  });
});

describe("saving", () => {
  test("reports each listing's success or failure; a failed listing keeps its edit and retries alone", async () => {
    saveResults = (updates) =>
      updates.map((u) => (u.listingId === 102 ? { listingId: 102, ok: false, error: "Etsy said no" } : { listingId: u.listingId, ok: true }));
    await renderEditor();
    openField("Title", "Listings");
    fireEvent.change(rowField("Title", 101), { target: { value: "First" } });
    fireEvent.change(rowField("Title", 102), { target: { value: "Second" } });
    fireEvent.click(syncButton());

    const status = await screen.findByText(/Updated 1 of 2 listings/);
    expect(status).toHaveTextContent("1 failed.");
    expect(status).toHaveTextContent("Listing 102: Etsy said no");
    expect(inRow(102).getByText(/Etsy said no/)).toBeInTheDocument();
    expect(rowField("Title", 102)).toHaveValue("Second");
    expect(syncButton()).toHaveTextContent("Sync updates (1)");
    // Only the listing that failed stays selected, so a second Sync retries it alone.
    expect(screen.getByLabelText("Include Listing 102 in the save")).toBeChecked();
    expect(screen.getByLabelText("Include First in the save")).not.toBeChecked();

    saveResults = null;
    fireEvent.click(syncButton());
    await waitFor(() => expect(allSaves()).toHaveLength(3));
    expect(allSaves()[2]).toEqual([{ listingId: 102, patch: { title: "Second" } }]);
  });

  test("while syncing, the button spins and Cancel and Schedule are closed off", async () => {
    const gate = deferred();
    saveDelay = () => gate.promise;
    await renderEditor();
    openField("Title", "Listings");
    fireEvent.change(rowField("Title", 101), { target: { value: "First" } });
    fireEvent.click(syncButton());

    const syncing = await screen.findByRole("button", { name: "Syncing…" });
    expect(syncing).toBeDisabled();
    expect(screen.getByRole("button", { name: "Schedule" })).toBeDisabled();
    expect(screen.getByRole("link", { name: "Cancel" })).toHaveAttribute("aria-disabled", "true");

    gate.resolve();
    await waitFor(() => expect(syncButton()).toHaveTextContent(/^Sync updates$/));
    expect(screen.getByRole("link", { name: "Cancel" })).not.toHaveAttribute("aria-disabled");
    // Schedule stores what is still pending, so it comes back with the next edit.
    fireEvent.change(rowField("Title", 102), { target: { value: "Second" } });
    expect(screen.getByRole("button", { name: "Schedule" })).toBeEnabled();
  });

  test("the progress line counts the listings written so far", async () => {
    const gates = new Map([101, 102, 103].map((id) => [id, deferred()]));
    saveDelay = (id) => gates.get(id)!.promise;
    await renderEditor();
    openField("Title", "Listings");
    for (const id of [101, 102, 103]) fireEvent.change(rowField("Title", id), { target: { value: `New ${id}` } });
    fireEvent.click(syncButton());

    expect(await screen.findByText("Syncing 0 of 3…")).toBeInTheDocument();
    gates.get(101)!.resolve();
    expect(await screen.findByText("Syncing 1 of 3…")).toBeInTheDocument();
    gates.get(102)!.resolve();
    expect(await screen.findByText("Syncing 2 of 3…")).toBeInTheDocument();
    gates.get(103)!.resolve();

    await screen.findByText(/Updated 3 of 3 listings/);
    expect(screen.queryByText(/^Syncing/)).not.toBeInTheDocument();
  });

  test("a write that never answers is failed after 30 seconds and the rest still go out", async () => {
    saveDelay = (id) => (id === 101 ? new Promise<void>(() => {}) : Promise.resolve());
    await renderEditor();
    openField("Title", "Listings");
    fireEvent.change(rowField("Title", 101), { target: { value: "First" } });
    fireEvent.change(rowField("Title", 102), { target: { value: "Second" } });

    vi.useFakeTimers();
    fireEvent.click(syncButton());
    await vi.advanceTimersByTimeAsync(30_000);
    vi.useRealTimers();

    const status = await screen.findByText(/Updated 1 of 2 listings/);
    expect(status).toHaveTextContent("Listing 101: Timed out after 30 seconds.");
    expect(savedUpdates()!.map((u) => u.listingId)).toEqual([101, 102]);
    expect(syncButton()).toBeEnabled();
    expect(screen.queryByText(/^Syncing/)).not.toBeInTheDocument();
  });
});

describe("layout", () => {
  test("the header names the shop, and the icon beside it hides and shows the field list", async () => {
    await renderEditor();
    expect(await screen.findByText("GHCollectiveUS")).toBeInTheDocument();
    const toggle = screen.getByRole("button", { name: "Hide field list" });
    fireEvent.click(toggle);
    expect(screen.queryByRole("navigation", { name: "Fields" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Show field list" }));
    expect(screen.getByRole("navigation", { name: "Fields" })).toBeInTheDocument();
  });

  test("each row shows the listing's full title above its control", async () => {
    const long = "A very long listing title that goes on well past what a single clamped line would ever show";
    await renderEditor([detail(101, { title: long })]);
    expect(within(screen.getByRole("group", { name: long })).getByText(long)).not.toHaveClass("line-clamp-1");
  });

  test("only the rows near the viewport are mounted", async () => {
    const many = Array.from({ length: 60 }, (_, i) => detail(1000 + i));
    await renderEditor(many);
    const mounted = screen.getAllByRole("group", { name: /^Listing \d+$/ }).length;
    expect(mounted).toBeGreaterThan(3);
    expect(mounted).toBeLessThan(60);
  });
});

describe("scheduling the pending edits", () => {
  /** Opens the picker and confirms it with the time it suggests. */
  async function scheduleNow() {
    fireEvent.click(screen.getByRole("button", { name: "Schedule" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Schedule edits" }));
  }

  test("Schedule is offered only once something has changed", async () => {
    await renderEditor();
    expect(screen.getByRole("button", { name: "Schedule" })).toBeDisabled();

    openField("Title", "Listings");
    fireEvent.change(rowField("Title", 101), { target: { value: "First" } });
    expect(screen.getByRole("button", { name: "Schedule" })).toBeEnabled();
  });

  test("stores every pending change as a job, writing nothing to Etsy", async () => {
    await renderEditor();
    openField("Title", "Listings");
    fireEvent.change(rowField("Title", 101), { target: { value: "First" } });
    fireEvent.change(rowField("Title", 102), { target: { value: "Second" } });

    await scheduleNow();

    await waitFor(() => expect(scheduleCalls()).toHaveLength(1));
    const [body] = scheduleCalls();
    expect(body).toMatchObject({
      kind: "bulk_edit",
      timezone: expect.any(String),
      updates: [
        { listingId: 101, title: "Listing 101", patch: { title: "First" } },
        { listingId: 102, title: "Listing 102", patch: { title: "Second" } },
      ],
    });
    expect(allSaves()).toHaveLength(0);
    expect(await screen.findByText(/Scheduled 2 listings for/)).toBeInTheDocument();
  });

  /** Puts one picked file into listing 101's photo grid, as the empty-slot picker does. */
  function addPhoto() {
    URL.createObjectURL = vi.fn(() => "blob:new");
    URL.revokeObjectURL = vi.fn();
    const input = screen
      .getByRole("group", { name: "Listing 101" })
      .querySelector<HTMLInputElement>('[data-testid="photo-file-input"]')!;
    fireEvent.change(input, { target: { files: [new File(["bytes"], "back.jpg", { type: "image/jpeg" })] } });
  }

  test("a photo added to a row is uploaded to the job's storage first", async () => {
    await renderEditor();
    openField("Photos", "Media");
    addPhoto();

    await scheduleNow();

    await waitFor(() => expect(scheduleCalls()).toHaveLength(1));
    const [update] = scheduleCalls()[0].updates;
    expect(update.media.imageFiles).toEqual([
      { key: expect.stringContaining("media-101-image-00"), filename: "back.jpg", contentType: "image/jpeg" },
    ]);
    expect(update.media.images).toEqual([
      { kind: "existing", imageId: 1, altText: "" },
      { kind: "new", index: 0, altText: "" },
    ]);
  });

  test("without file storage the picker says so and nothing is scheduled", async () => {
    storageConfigured = false;
    await renderEditor();
    openField("Photos", "Media");
    addPhoto();

    await scheduleNow();

    expect(await screen.findByRole("alert")).toHaveTextContent("File storage (R2) isn't set up yet.");
    expect(scheduleCalls()).toHaveLength(0);
  });

  test("once scheduled, the screen holds nothing unsaved", async () => {
    await renderEditor();
    openField("Title", "Listings");
    fireEvent.change(rowField("Title", 101), { target: { value: "First" } });

    const warned = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(warned);
    expect(warned.defaultPrevented).toBe(true);

    await scheduleNow();
    await screen.findByText(/Scheduled 1 listing for/);

    const after = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(after);
    expect(after.defaultPrevented).toBe(false);
    expect(syncButton()).toBeDisabled();
  });
});
