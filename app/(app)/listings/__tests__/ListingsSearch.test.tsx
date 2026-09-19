// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const { pushMock } = vi.hoisted(() => ({ pushMock: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: pushMock }) }));
vi.mock("../SidebarContext", () => ({
  SIDEBAR_ID: "app-sidebar",
  LISTINGS_HOME_EVENT: "listhouse:listings-home",
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

const LISTINGS = [
  row(100, { title: "Blue Ceramic Mug", sku: "MUG-BLUE-001" }),
  row(101, { title: "Red Ceramic Mug", sku: "MUG-RED-001" }),
  row(102, { title: "Green Ceramic Bowl", sku: "BOWL-GREEN-001" }),
  row(103, { title: "Handmade Wooden Cup", sku: "CUP-WOOD-001" }),
  row(104, { title: "Silver Metal Teapot", sku: "POT-SILVER-001" }),
];

let fetchMock: ReturnType<typeof vi.fn>;

function jsonResponse(body: unknown, status = 200) {
  return { ok: status < 400, status, json: async () => body };
}

function mockFetch() {
  fetchMock = vi.fn(async (url: string) => {
    if (url.startsWith("/api/drafts")) return jsonResponse({ drafts: [] });
    if (url.startsWith("/api/etsy/listings/counts")) {
      return jsonResponse({ counts: { active: LISTINGS.length, draft: 0 } });
    }
    if (url.startsWith("/api/etsy/sections")) {
      return jsonResponse({ sections: [] });
    }
    if (url.startsWith("/api/etsy/listings?")) {
      const params = new URLSearchParams(url.split("?")[1]);
      const all = params.get("all") === "true";
      const state = params.get("state") ?? "active";
      if (state === "draft") {
        return jsonResponse({ shopId: 1, count: 0, limit: 24, offset: 0, listings: [] });
      }
      if (all) {
        return jsonResponse({
          shopId: 1,
          count: LISTINGS.length,
          limit: LISTINGS.length,
          offset: 0,
          listings: LISTINGS,
        });
      }
      const offset = Number(params.get("offset") ?? 0);
      const limit = Number(params.get("limit") ?? 24);
      return jsonResponse({
        shopId: 1,
        count: LISTINGS.length,
        limit,
        offset,
        listings: LISTINGS.slice(offset, offset + limit),
      });
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
}

async function renderPage() {
  mockFetch();
  render(<ListingsPage />);
  await screen.findByText("Blue Ceramic Mug");
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("search by keyword", () => {
  test("filters listings by title when typing a keyword", async () => {
    await renderPage();
    expect(screen.getByText("Blue Ceramic Mug")).toBeInTheDocument();
    expect(screen.getByText("Red Ceramic Mug")).toBeInTheDocument();
    expect(screen.getByText("Green Ceramic Bowl")).toBeInTheDocument();

    fireEvent.change(screen.getByTestId("search-input"), {
      target: { value: "mug" },
    });

    await waitFor(() => {
      expect(screen.getByText("Blue Ceramic Mug")).toBeInTheDocument();
      expect(screen.getByText("Red Ceramic Mug")).toBeInTheDocument();
      expect(screen.queryByText("Green Ceramic Bowl")).not.toBeInTheDocument();
      expect(screen.queryByText("Handmade Wooden Cup")).not.toBeInTheDocument();
    });
  });

  test("performs case-insensitive search", async () => {
    await renderPage();
    fireEvent.change(screen.getByTestId("search-input"), {
      target: { value: "CERAMIC" },
    });

    await waitFor(() => {
      expect(screen.getByText("Blue Ceramic Mug")).toBeInTheDocument();
      expect(screen.getByText("Red Ceramic Mug")).toBeInTheDocument();
      expect(screen.getByText("Green Ceramic Bowl")).toBeInTheDocument();
      expect(screen.queryByText("Handmade Wooden Cup")).not.toBeInTheDocument();
    });
  });

  test("matches partial words in titles", async () => {
    await renderPage();
    fireEvent.change(screen.getByTestId("search-input"), {
      target: { value: "cup" },
    });

    await waitFor(() => {
      expect(screen.getByText("Handmade Wooden Cup")).toBeInTheDocument();
      expect(screen.queryByText("Blue Ceramic Mug")).not.toBeInTheDocument();
    });
  });
});

describe("search by SKU", () => {
  test("filters listings by SKU when typing an SKU", async () => {
    await renderPage();
    fireEvent.change(screen.getByTestId("search-input"), {
      target: { value: "MUG-BLUE" },
    });

    await waitFor(() => {
      expect(screen.getByText("Blue Ceramic Mug")).toBeInTheDocument();
      expect(screen.queryByText("Red Ceramic Mug")).not.toBeInTheDocument();
    });
  });

  test("performs case-insensitive search on SKUs", async () => {
    await renderPage();
    fireEvent.change(screen.getByTestId("search-input"), {
      target: { value: "mug-red" },
    });

    await waitFor(() => {
      expect(screen.getByText("Red Ceramic Mug")).toBeInTheDocument();
      expect(screen.queryByText("Blue Ceramic Mug")).not.toBeInTheDocument();
    });
  });

  test("matches partial SKU values", async () => {
    await renderPage();
    fireEvent.change(screen.getByTestId("search-input"), {
      target: { value: "POT" },
    });

    await waitFor(() => {
      expect(screen.getByText("Silver Metal Teapot")).toBeInTheDocument();
      expect(screen.queryByText("Blue Ceramic Mug")).not.toBeInTheDocument();
    });
  });
});

describe("search clear button", () => {
  test("shows clear button when search is active", async () => {
    await renderPage();
    expect(screen.queryByTestId("search-clear")).not.toBeInTheDocument();

    fireEvent.change(screen.getByTestId("search-input"), {
      target: { value: "mug" },
    });

    await waitFor(() => {
      expect(screen.getByTestId("search-clear")).toBeInTheDocument();
    });
  });

  test("clears the search when the clear button is clicked", async () => {
    await renderPage();
    fireEvent.change(screen.getByTestId("search-input"), {
      target: { value: "mug" },
    });

    await waitFor(() => {
      expect(screen.queryByText("Green Ceramic Bowl")).not.toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId("search-clear"));

    await waitFor(() => {
      expect((screen.getByTestId("search-input") as HTMLInputElement).value).toBe("");
      expect(screen.getByText("Green Ceramic Bowl")).toBeInTheDocument();
    });
  });
});

describe("search with no results", () => {
  test("shows the no results message when search has no matches", async () => {
    await renderPage();
    fireEvent.change(screen.getByTestId("search-input"), {
      target: { value: "nonexistent" },
    });

    await waitFor(() => {
      expect(screen.getByText(/No active listings found/)).toBeInTheDocument();
      expect(screen.queryByText("Blue Ceramic Mug")).not.toBeInTheDocument();
    });
  });
});

describe("search combined with existing filters", () => {
  test("search works together with state filters", async () => {
    await renderPage();
    // Add a draft listing
    fetchMock.mockImplementation(async (url: string) => {
      if (url.startsWith("/api/drafts")) return jsonResponse({ drafts: [] });
      if (url.startsWith("/api/etsy/listings/counts")) {
        return jsonResponse({ counts: { active: LISTINGS.length, draft: 1 } });
      }
      if (url.startsWith("/api/etsy/sections")) {
        return jsonResponse({ sections: [] });
      }
      if (url.startsWith("/api/etsy/listings?")) {
        const params = new URLSearchParams(url.split("?")[1]);
        const isDraft = params.get("state") === "draft";
        if (isDraft) {
          return jsonResponse({
            shopId: 1,
            count: 1,
            limit: 24,
            offset: 0,
            listings: [row(200, { title: "Draft Mug", state: "draft" })],
          });
        }
        return jsonResponse({
          shopId: 1,
          count: LISTINGS.length,
          limit: 24,
          offset: 0,
          listings: LISTINGS,
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    // Initially on active, search for "mug"
    fireEvent.change(screen.getByTestId("search-input"), {
      target: { value: "mug" },
    });

    await waitFor(() => {
      expect(screen.getByText("Blue Ceramic Mug")).toBeInTheDocument();
      expect(screen.getByText("Red Ceramic Mug")).toBeInTheDocument();
    });

    // Switch to draft tab
    fireEvent.click(screen.getByRole("button", { name: /^Draft/ }));
    await screen.findByText("Draft Mug");

    // Search should still apply to the draft filter
    fireEvent.change(screen.getByTestId("search-input"), {
      target: { value: "draft" },
    });

    await waitFor(() => {
      expect(screen.getByText("Draft Mug")).toBeInTheDocument();
    });
  });

  test("search resets pagination offset", async () => {
    await renderPage();
    // Simulate being on page 2
    fireEvent.change(screen.getByTestId("search-input"), {
      target: { value: "mug" },
    });

    await waitFor(() => {
      // When search is applied, offset should reset to 0
      expect(screen.queryByText("Handmade Wooden Cup")).not.toBeInTheDocument();
    });
  });
});

describe("My drafts schedule badge", () => {
  test("a draft with a pending scheduled publish shows a clock badge; others don't", async () => {
    mockFetch();
    const drafts = [
      { id: "d1", title: "Scheduled tee", thumbnailUrl: null, updatedAt: "2026-09-19T10:00:00Z", scheduledAt: "2026-09-21T15:00:00Z" },
      { id: "d2", title: "Plain tee", thumbnailUrl: null, updatedAt: "2026-09-19T10:00:00Z", scheduledAt: null },
    ];
    const base = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (url: string) =>
      url.startsWith("/api/drafts") ? jsonResponse({ drafts }) : base(url),
    );
    render(<ListingsPage />);
    await screen.findByText("Blue Ceramic Mug");
    fireEvent.click(screen.getByRole("button", { name: /My drafts/ }));
    await screen.findByText("Scheduled tee");
    expect(screen.getAllByLabelText(/^Scheduled for /)).toHaveLength(1);
  });
});

describe("wordmark home", () => {
  test("from My drafts, the wordmark's home event goes back to Active listings", async () => {
    await renderPage();
    fireEvent.click(screen.getByRole("button", { name: /My drafts/ }));
    await waitFor(() => expect(screen.queryByText("Blue Ceramic Mug")).not.toBeInTheDocument());
    act(() => {
      window.dispatchEvent(new Event("listhouse:listings-home"));
    });
    await screen.findByText("Blue Ceramic Mug");
  });
});
