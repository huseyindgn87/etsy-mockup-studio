// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import BulkEditor from "../BulkEditor";
import { MAX_TITLE_LENGTH } from "@/lib/etsy/bulk-edit";

interface Detail {
  listingId: number;
  title: string;
  description: string;
  tags: string[];
  state: string;
  url: string;
  thumbnailUrl: string | null;
  shopSectionId: number | null;
  shippingProfileId: number | null;
  shouldAutoRenew: boolean;
  isTaxable: boolean;
  price: number | null;
  quantity: number;
  sku: string;
  hasVariations: boolean;
}

function detail(listingId: number, overrides: Partial<Detail> = {}): Detail {
  return {
    listingId,
    title: `Listing ${listingId}`,
    description: "",
    tags: [],
    state: "active",
    url: `https://etsy.com/listing/${listingId}`,
    thumbnailUrl: null,
    shopSectionId: null,
    shippingProfileId: null,
    shouldAutoRenew: true,
    isTaxable: true,
    price: 10,
    quantity: 3,
    sku: "",
    hasVariations: false,
    ...overrides,
  };
}

const LISTINGS = [detail(101), detail(102), detail(103)];

let fetchMock: ReturnType<typeof vi.fn>;

function jsonResponse(body: unknown, status = 200) {
  return { ok: status < 400, status, json: async () => body };
}

/** Routes every request the editor makes; bulk saves are recorded for assertions. */
function mockFetch(listings: Detail[] = LISTINGS) {
  fetchMock = vi.fn(async (url: string) => {
    if (url.startsWith("/api/etsy/listings/bulk?")) {
      return jsonResponse({ listings, missing: [] });
    }
    if (url === "/api/etsy/sections") {
      return jsonResponse({ sections: [{ shopSectionId: 9, title: "Mugs" }] });
    }
    if (url === "/api/etsy/shipping-profiles") {
      return jsonResponse({ profiles: [{ shippingProfileId: 44, title: "Standard" }] });
    }
    if (url === "/api/etsy/listings/bulk/save") {
      return jsonResponse({
        results: listings.map((l) => ({ listingId: l.listingId, ok: true })),
      });
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
const rowField = (field: string, listing: number) => screen.getByLabelText(`${field} for Listing ${listing}`);
const applyAllField = (field: string) => screen.getByLabelText(`${field} to apply to all`);
const applyAllButton = (field: string) =>
  screen.getByRole("button", { name: new RegExp(`Apply ${field} to all`, "i") });

const saveButton = () => screen.getByRole("button", { name: /^Save all changes/ });
const openSection = (name: string) => fireEvent.click(screen.getByRole("button", { name }));

async function renderEditor(listings: Detail[] = LISTINGS) {
  mockFetch(listings);
  render(<BulkEditor listingIds={listings.map((l) => l.listingId)} />);
  await screen.findByText(`Editing ${listings.length} listings`);
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("loading", () => {
  test("heads the screen with the number of listings being edited", async () => {
    await renderEditor();
    expect(screen.getByText("Editing 3 listings")).toBeInTheDocument();
  });

  test("offers Cancel and a save action", async () => {
    await renderEditor();
    expect(screen.getByRole("link", { name: "Cancel" })).toHaveAttribute("href", "/listings");
    expect(saveButton()).toBeDisabled(); // nothing changed yet
  });

  test("lists every section in the sidebar", async () => {
    await renderEditor();
    for (const label of [
      "Title",
      "Description",
      "Tags",
      "Media",
      "Listing details",
      "Optional",
      "Inventory",
      "Shipping",
    ]) {
      expect(screen.getByRole("button", { name: label })).toBeInTheDocument();
    }
  });
});

describe("nothing is sent to Etsy until Save is pressed", () => {
  test("typing in a row makes no request at all", async () => {
    await renderEditor();
    const before = fetchMock.mock.calls.length;
    fireEvent.change(rowField("Title", 101), { target: { value: "Edited in the browser" } });
    expect(fetchMock.mock.calls.length).toBe(before);
    expect(savedUpdates()).toBeNull();
  });

  test("applying a value to every row still sends nothing", async () => {
    await renderEditor();
    fireEvent.change(applyAllField("Title"), { target: { value: "Everything" } });
    fireEvent.click(applyAllButton("title"));
    expect(savedUpdates()).toBeNull();
  });

  test("the save request goes out only on the explicit click", async () => {
    await renderEditor();
    fireEvent.change(rowField("Title", 101), { target: { value: "Renamed" } });
    expect(savedUpdates()).toBeNull();

    fireEvent.click(saveButton());
    await waitFor(() => expect(savedUpdates()).not.toBeNull());
    expect(savedUpdates()).toEqual([{ listingId: 101, patch: { title: "Renamed" } }]);
  });
});

describe("per-row targeting", () => {
  test("a change to one row is written to that row alone", async () => {
    await renderEditor();
    fireEvent.change(rowField("Title", 102), { target: { value: "Only me" } });
    fireEvent.click(saveButton());
    await waitFor(() => expect(savedUpdates()).not.toBeNull());
    expect(savedUpdates()).toEqual([{ listingId: 102, patch: { title: "Only me" } }]);
  });

  test("different fields on different rows all land in one save", async () => {
    await renderEditor();
    fireEvent.change(rowField("Title", 101), { target: { value: "New title" } });

    openSection("Tags");
    const tagInput = rowField("Tags", 102);
    fireEvent.change(tagInput, { target: { value: "handmade" } });
    fireEvent.keyDown(tagInput, { key: "Enter" });

    openSection("Shipping");
    fireEvent.change(rowField("Shipping profile", 103), { target: { value: "44" } });

    fireEvent.click(saveButton());
    await waitFor(() => expect(savedUpdates()).not.toBeNull());
    expect(savedUpdates()).toEqual([
      { listingId: 101, patch: { title: "New title" } },
      { listingId: 102, patch: { tags: ["handmade"] } },
      { listingId: 103, patch: { shippingProfileId: 44 } },
    ]);
  });

  test("unticking a row keeps its change out of the save", async () => {
    await renderEditor();
    fireEvent.change(rowField("Title", 101), { target: { value: "Changed" } });
    fireEvent.change(rowField("Title", 102), { target: { value: "Also changed" } });
    fireEvent.click(screen.getByLabelText("Include Listing 101 in the save"));

    fireEvent.click(saveButton());
    await waitFor(() => expect(savedUpdates()).not.toBeNull());
    expect(savedUpdates()).toEqual([{ listingId: 102, patch: { title: "Also changed" } }]);
  });

  test("a row typed back to its original value contributes nothing", async () => {
    await renderEditor();
    const input = rowField("Title", 101);
    fireEvent.change(input, { target: { value: "Changed" } });
    fireEvent.change(input, { target: { value: "Listing 101" } });
    expect(saveButton()).toBeDisabled();
  });
});

describe("apply to all selected", () => {
  test("writes one value into every ticked row, and saves them all", async () => {
    await renderEditor();
    fireEvent.change(applyAllField("Title"), { target: { value: "Shared title" } });
    fireEvent.click(applyAllButton("title"));

    for (const id of [101, 102, 103]) {
      expect(rowField("Title", id)).toHaveValue("Shared title");
    }

    fireEvent.click(saveButton());
    await waitFor(() => expect(savedUpdates()).not.toBeNull());
    expect(savedUpdates()).toEqual([
      { listingId: 101, patch: { title: "Shared title" } },
      { listingId: 102, patch: { title: "Shared title" } },
      { listingId: 103, patch: { title: "Shared title" } },
    ]);
  });

  test("skips rows the user has unticked", async () => {
    await renderEditor();
    fireEvent.click(screen.getByLabelText("Include Listing 102 in the save"));
    fireEvent.change(applyAllField("Title"), { target: { value: "Shared" } });
    fireEvent.click(applyAllButton("title"));

    expect(rowField("Title", 102)).toHaveValue("Listing 102");
    fireEvent.click(saveButton());
    await waitFor(() => expect(savedUpdates()).not.toBeNull());
    expect(savedUpdates()!.map((u) => u.listingId)).toEqual([101, 103]);
  });

  test("a per-row edit after an apply-to-all wins for that row", async () => {
    await renderEditor();
    fireEvent.change(applyAllField("Title"), { target: { value: "Shared" } });
    fireEvent.click(applyAllButton("title"));
    fireEvent.change(rowField("Title", 102), { target: { value: "Special" } });

    fireEvent.click(saveButton());
    await waitFor(() => expect(savedUpdates()).not.toBeNull());
    expect(savedUpdates()).toEqual([
      { listingId: 101, patch: { title: "Shared" } },
      { listingId: 102, patch: { title: "Special" } },
      { listingId: 103, patch: { title: "Shared" } },
    ]);
  });
});

describe("character counters", () => {
  test("the title counter counts down as you type", async () => {
    await renderEditor();
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
    expect(rowField("Title", 101)).toHaveAttribute("maxlength", String(MAX_TITLE_LENGTH));
  });

  test("description has no counter — Etsy documents no limit for it", async () => {
    await renderEditor();
    openSection("Description");
    const field = rowField("Description", 101).closest("label")!;
    expect(within(field).queryByText(/left$/)).not.toBeInTheDocument();
  });

  test("tags show how many of Etsy's 13 are used", async () => {
    await renderEditor();
    openSection("Tags");
    expect(screen.getAllByText("0/13").length).toBeGreaterThan(0);
  });
});

describe("listings that can't take an inventory edit", () => {
  test("a variation listing says so instead of offering price and quantity", async () => {
    await renderEditor([detail(101), detail(102, { hasVariations: true })]);
    openSection("Inventory");
    expect(rowField("Price", 101)).toBeInTheDocument();
    expect(screen.queryByLabelText("Price for Listing 102")).not.toBeInTheDocument();
    expect(screen.getByText(/Price varies by variation on this listing/i)).toBeInTheDocument();
  });

  test("apply-to-all skips it rather than flattening its grid", async () => {
    await renderEditor([detail(101), detail(102, { hasVariations: true })]);
    openSection("Inventory");
    fireEvent.change(applyAllField("Price"), { target: { value: "20" } });
    fireEvent.click(applyAllButton("price"));

    fireEvent.click(saveButton());
    await waitFor(() => expect(savedUpdates()).not.toBeNull());
    expect(savedUpdates()).toEqual([{ listingId: 101, patch: { price: 20 } }]);
  });
});

describe("search", () => {
  test("filters the rows on screen without dropping their pending edits", async () => {
    await renderEditor();
    fireEvent.change(rowField("Title", 103), { target: { value: "Kept" } });
    fireEvent.change(screen.getByPlaceholderText("Search these listings by title…"), {
      target: { value: "101" },
    });

    expect(screen.queryByLabelText("Title for Listing 103")).not.toBeInTheDocument();
    fireEvent.click(saveButton());
    await waitFor(() => expect(savedUpdates()).not.toBeNull());
    expect(savedUpdates()).toEqual([{ listingId: 103, patch: { title: "Kept" } }]);
  });
});
