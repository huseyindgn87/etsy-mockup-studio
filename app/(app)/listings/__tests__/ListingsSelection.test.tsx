// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const { pushMock } = vi.hoisted(() => ({ pushMock: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: pushMock }) }));
vi.mock("../SidebarContext", () => ({
  SIDEBAR_ID: "app-sidebar",
  useSidebar: () => ({ open: true, toggle: () => {} }),
}));

import ListingsPage from "../page";

interface Row {
  listingId: number;
  title: string;
  state: string;
  url: string;
  quantity: number;
  price: string | null;
  thumbnailUrl: string | null;
  endingTimestampMs: number | null;
  shopSectionId: number | null;
  sku: string | null;
}

function row(listingId: number, overrides: Partial<Row> = {}): Row {
  return {
    listingId,
    title: `Listing ${listingId}`,
    state: "active",
    url: `https://etsy.com/listing/${listingId}`,
    quantity: 1,
    price: "$10.00",
    thumbnailUrl: null,
    endingTimestampMs: null,
    shopSectionId: null,
    sku: null,
    ...overrides,
  };
}

/** 26 active listings — two pages at the page size of 24. */
const ACTIVE = Array.from({ length: 26 }, (_, i) => row(100 + i));
const DRAFTS = [row(900, { state: "draft" }), row(901, { state: "draft" })];

let fetchMock: ReturnType<typeof vi.fn>;

function jsonResponse(body: unknown, status = 200) {
  return { ok: status < 400, status, json: async () => body };
}

function mockFetch() {
  fetchMock = vi.fn(async (url: string) => {
    if (url.startsWith("/api/drafts")) return jsonResponse({ drafts: [] });
    if (url.startsWith("/api/etsy/listings/counts")) {
      return jsonResponse({ counts: { active: ACTIVE.length, draft: DRAFTS.length } });
    }
    if (url.startsWith("/api/etsy/sections")) {
      return jsonResponse({ sections: [{ shopSectionId: 7, title: "Mugs" }] });
    }
    if (url.startsWith("/api/etsy/listings?")) {
      const params = new URLSearchParams(url.split("?")[1]);
      const all = params.get("all") === "true";
      const source = params.get("state") === "draft" ? DRAFTS : ACTIVE;
      if (all) {
        return jsonResponse({ shopId: 1, count: source.length, limit: source.length, offset: 0, listings: source });
      }
      const offset = Number(params.get("offset") ?? 0);
      const limit = Number(params.get("limit") ?? 24);
      return jsonResponse({
        shopId: 1,
        count: source.length,
        limit,
        offset,
        listings: source.slice(offset, offset + limit),
      });
    }
    if (url === "/api/etsy/listings/bulk/copy") return jsonResponse({ copied: 2 }, 200);
    throw new Error(`unexpected fetch: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
}

/** Requests that would change something — anything but a GET. */
function writeCalls(): string[] {
  return fetchMock.mock.calls
    .filter(([, init]) => (init as RequestInit | undefined)?.method)
    .map(([url]) => url as string);
}

const headerCheckbox = () => screen.getByLabelText("Select all on this page");
const summary = () => screen.getByRole("heading", { level: 2 }).textContent;

async function renderPage() {
  mockFetch();
  render(<ListingsPage />);
  await screen.findByLabelText("Select Listing 100");
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the header count", () => {
  test("reads as the plain tab name with nothing selected", async () => {
    await renderPage();
    expect(summary()).toBe("Active");
  });

  test("names the tab and the count once rows are ticked", async () => {
    await renderPage();
    fireEvent.click(screen.getByLabelText("Select Listing 100"));
    expect(summary()).toBe("Active — 1 selected");
    fireEvent.click(screen.getByLabelText("Select Listing 101"));
    expect(summary()).toBe("Active — 2 selected");
  });
});

describe("select all on this page vs. select all matching the filters", () => {
  test("the header checkbox takes only the 24 rows on this page", async () => {
    await renderPage();
    fireEvent.click(headerCheckbox());
    expect(summary()).toBe("Active — 24 selected");
  });

  test("'select all matching' takes all 26, including the ones on page two", async () => {
    await renderPage();
    fireEvent.click(screen.getByLabelText("Selection options"));
    fireEvent.click(screen.getByRole("button", { name: /Select all 26 matching these filters/ }));
    await waitFor(() => expect(summary()).toBe("Active — 26 selected"));
  });

  test("the page option names how many rows that is", async () => {
    await renderPage();
    fireEvent.click(screen.getByLabelText("Selection options"));
    expect(screen.getByRole("button", { name: /Select all on this page \(24\)/ })).toBeInTheDocument();
  });

  test("unticking the header clears just this page's rows", async () => {
    await renderPage();
    fireEvent.click(headerCheckbox());
    fireEvent.click(headerCheckbox());
    expect(summary()).toBe("Active");
  });
});

describe("selection survives pagination within the same filters", () => {
  test("rows stay selected after paging forward and back", async () => {
    await renderPage();
    fireEvent.click(screen.getByLabelText("Select Listing 100"));
    expect(summary()).toBe("Active — 1 selected");

    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await screen.findByLabelText("Select Listing 124");
    expect(summary()).toBe("Active — 1 selected");

    fireEvent.click(screen.getByRole("button", { name: "Previous" }));
    await screen.findByLabelText("Select Listing 100");
    expect(screen.getByLabelText("Select Listing 100")).toBeChecked();
  });

  test("selecting on both pages adds up", async () => {
    await renderPage();
    fireEvent.click(headerCheckbox());
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await screen.findByLabelText("Select Listing 124");
    fireEvent.click(screen.getByLabelText("Select Listing 124"));
    expect(summary()).toBe("Active — 25 selected");
  });
});

describe("selection clears when the filters change", () => {
  test("switching the state tab drops it", async () => {
    await renderPage();
    fireEvent.click(headerCheckbox());
    expect(summary()).toBe("Active — 24 selected");

    fireEvent.click(screen.getByRole("button", { name: /^Draft/ }));
    await screen.findByLabelText("Select Listing 900");
    expect(summary()).toBe("Draft");
  });

  test("choosing a section drops it", async () => {
    await renderPage();
    fireEvent.click(headerCheckbox());
    fireEvent.change(screen.getByLabelText("Section"), { target: { value: "7" } });
    await waitFor(() => expect(summary()).toBe("Active"));
  });

  test("coming back to the original tab does not bring the old rows back", async () => {
    await renderPage();
    fireEvent.click(headerCheckbox());
    fireEvent.click(screen.getByRole("button", { name: /^Draft/ }));
    await screen.findByLabelText("Select Listing 900");
    fireEvent.click(screen.getByRole("button", { name: /^Active/ }));
    await screen.findByLabelText("Select Listing 100");
    expect(summary()).toBe("Active");
  });
});

describe("the toolbar", () => {
  test("appears only once something is selected", async () => {
    await renderPage();
    expect(screen.queryByRole("button", { name: /^Delete$/ })).not.toBeInTheDocument();

    fireEvent.click(screen.getByLabelText("Select Listing 100"));
    for (const name of ["Delete", "Export", "Copy", "Bulk edit"]) {
      expect(screen.getByRole("button", { name })).toBeInTheDocument();
    }
  });

  test("Bulk edit carries the selection to the bulk screen", async () => {
    await renderPage();
    fireEvent.click(screen.getByLabelText("Select Listing 100"));
    fireEvent.click(screen.getByLabelText("Select Listing 102"));
    expect(screen.queryByRole("button", { name: "Edit" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Bulk edit" }));
    expect(pushMock).toHaveBeenCalledWith("/listings/bulk?ids=100,102");
  });

  test("Delete asks for confirmation, naming how many listings it affects", async () => {
    await renderPage();
    fireEvent.click(screen.getByLabelText("Select Listing 100"));
    fireEvent.click(screen.getByLabelText("Select Listing 101"));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveTextContent("Delete 2 listings?");
    expect(dialog).toHaveTextContent(/permanently deleted from Etsy/);
    // Still nothing sent — the confirmation hasn't been accepted.
    expect(writeCalls()).toEqual([]);
  });

  test("a single row's delete icon confirms with that listing's title", async () => {
    await renderPage();
    fireEvent.click(screen.getByLabelText("Delete Listing 105"));
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveTextContent("Delete listing?");
    expect(dialog).toHaveTextContent("Listing 105");
    expect(writeCalls()).toEqual([]);
  });

  test("cancelling the confirmation deletes nothing", async () => {
    await renderPage();
    fireEvent.click(screen.getByLabelText("Select Listing 100"));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(writeCalls()).toEqual([]);
  });

  test("Copy creates drafts and never writes to the listings", async () => {
    await renderPage();
    fireEvent.click(screen.getByLabelText("Select Listing 100"));
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));

    await screen.findByText(/Created 2 drafts/);
    expect(writeCalls()).toEqual(["/api/etsy/listings/bulk/copy"]);
  });
});

describe("row actions", () => {
  test("every row offers delete, copy, share and edit", async () => {
    await renderPage();
    expect(screen.getByLabelText("Delete Listing 100")).toBeInTheDocument();
    expect(screen.getByLabelText("Copy Listing 100")).toBeInTheDocument();
    expect(screen.getByLabelText("Share Listing 100")).toBeInTheDocument();
    expect(screen.getByLabelText("Edit Listing 100")).toBeInTheDocument();
  });

  test("share copies the listing's link", async () => {
    await renderPage();
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });

    fireEvent.click(screen.getByLabelText("Share Listing 100"));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("https://etsy.com/listing/100"));
  });
});

describe("browsing sends nothing that changes a listing", () => {
  test("loading, selecting and paging are all reads", async () => {
    await renderPage();
    fireEvent.click(headerCheckbox());
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await screen.findByLabelText("Select Listing 124");
    expect(writeCalls()).toEqual([]);
  });
});

describe("opening a listing", () => {
  const editorPath = "/mockups?mode=existing&listingId=100&title=Listing+100";

  test("clicking a row opens our own editor for that listing, not Etsy", async () => {
    await renderPage();
    fireEvent.click(screen.getByTestId("listing-row-100").querySelectorAll("td")[3]);
    expect(pushMock).toHaveBeenCalledWith(editorPath);
    expect(pushMock.mock.calls.flat().join(" ")).not.toContain("etsy.com");
  });

  test("the title links to our editor too", async () => {
    await renderPage();
    expect(screen.getByRole("link", { name: "Listing 100" })).toHaveAttribute("href", editorPath);
  });

  test("clicking the thumbnail cell or a metadata cell opens the editor too", async () => {
    await renderPage();
    const cells = screen.getByTestId("listing-row-100").querySelectorAll("td");
    for (const cell of [cells[1], cells[2], cells[4], cells[5]]) {
      pushMock.mockClear();
      fireEvent.click(cell);
      expect(pushMock).toHaveBeenCalledWith(editorPath);
    }
  });

  test("the row holds no link out to Etsy", async () => {
    await renderPage();
    const row = screen.getByTestId("listing-row-100");
    expect(row.querySelector('a[href*="etsy.com"]')).toBeNull();
    expect(within(row).queryByRole("link", { name: /on Etsy/ })).not.toBeInTheDocument();
  });

  test("the hover action icons don't navigate the row", async () => {
    await renderPage();
    const row = within(screen.getByTestId("listing-row-100"));
    fireEvent.click(row.getByLabelText("Copy Listing 100"));
    fireEvent.click(row.getByLabelText("Edit Listing 100"));
    fireEvent.click(row.getByLabelText("Share Listing 100"));
    fireEvent.click(row.getByLabelText("Delete Listing 100"));
    expect(pushMock).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toHaveTextContent(/permanently deleted from Etsy/);
  });

  test("clicking the checkbox selects the row and doesn't navigate", async () => {
    await renderPage();
    const checkbox = screen.getByLabelText("Select Listing 100");
    fireEvent.click(checkbox);
    expect(checkbox).toBeChecked();
    fireEvent.click(checkbox.closest("td")!);
    expect(pushMock).not.toHaveBeenCalled();
  });
});
