// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const LISTING_ID = 4440391068;
const TITLE = "Happy Meowentine Cats T-Shirt";

const nav = vi.hoisted(() => ({
  params: new URLSearchParams(),
  router: { replace: vi.fn(), push: vi.fn(), refresh: vi.fn(), back: vi.fn(), prefetch: vi.fn() },
}));
vi.mock("next/navigation", () => ({
  useSearchParams: () => nav.params,
  useRouter: () => nav.router,
  usePathname: () => "/mockups",
}));

import MockupsPage from "../page";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

let draftPuts = 0;

function route(method: string, url: string): Response {
  if (url.startsWith("data:")) return new Response(new Blob(["x"], { type: "image/jpeg" }));
  if (url === `/api/etsy/listings/${LISTING_ID}/copy-source`) {
    return json({
      title: TITLE,
      description: "One shirt, not a set.",
      tags: ["cat shirt"],
      price: 23.69,
      shopSectionId: null,
      images: [{ dataUrl: "data:image/jpeg;base64,AA", fileName: "photo-1.jpg", altText: "A cat" }],
    });
  }
  if (url.startsWith("/api/etsy/listings/bulk?ids=")) {
    return json({
      listings: [{ images: [{ listingImageId: 11, url570xN: "https://i.etsy/1.jpg", altText: "A cat" }], videos: [] }],
      missing: [],
    });
  }
  if (url === `/api/etsy/listings/${LISTING_ID}/editor`) {
    return json({ form: null, source: "cache", warning: null }, 404);
  }
  if (url === "/api/etsy/shop") return json({ shopName: "GHCollectiveUS", currencyCode: "USD" });
  if (url === "/api/etsy/sections") return json({ sections: [] });
  if (url === "/api/etsy/processing-profiles") return json({ profiles: [] });
  if (url === "/api/etsy/production-partners") return json({ partners: [] });
  if (url === "/api/etsy/taxonomy") {
    return json({
      tree: [
        {
          id: 1,
          level: 1,
          name: "Clothing",
          parentId: null,
          children: [{ id: 482, level: 2, name: "T-shirts", parentId: 1, children: [] }],
        },
      ],
    });
  }
  if (url === "/api/etsy/taxonomy/482/properties") return json({ properties: [] });
  if (method === "POST" && url === "/api/drafts") return json({ id: "draft-1" });
  if (method === "PUT" && url.startsWith("/api/drafts/draft-1")) {
    if (url === "/api/drafts/draft-1") draftPuts += 1;
    return json({ id: "draft-1" });
  }
  if (url.startsWith("/api/schedule")) return json({ scheduledListings: [] });
  return json({ error: "not mocked" }, 404);
}

beforeEach(() => {
  draftPuts = 0;
  Element.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: () => "blob:photo", revokeObjectURL: () => {} }));
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      return route((init?.method ?? "GET").toUpperCase(), url);
    }),
  );
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Clicks an in-app link outside the page, the way the wordmark in the top bar is. */
function leavePage() {
  const anchor = document.createElement("a");
  anchor.href = "/listings";
  document.body.appendChild(anchor);
  fireEvent.click(anchor, { button: 0 });
  return anchor;
}

/** Past the 2 s autosave debounce, which used to clear the unsaved flag on its own. */
const letAutosaveRun = () => act(() => new Promise((resolve) => setTimeout(resolve, 3000)));

const section = (label: string) => within(screen.getByRole("region", { name: label }));

async function openNew() {
  nav.params = new URLSearchParams();
  render(<MockupsPage />);
  await waitFor(() => expect(screen.getByRole("navigation")).toBeInTheDocument());
}

async function openCopy() {
  nav.params = new URLSearchParams({ mode: "copy", listingId: String(LISTING_ID), title: TITLE });
  render(<MockupsPage />);
  await screen.findByRole("img", { name: /photo-1\.jpg|A cat/ });
}

describe("the editor warns before unsaved work is lost", () => {
  it("a title edit still counts as unsaved after the autosave has run", async () => {
    await openNew();
    fireEvent.change(section("Title").getByPlaceholderText("e.g. Miami Skyline Wall Art Print"), {
      target: { value: "Cat shirt" },
    });

    await letAutosaveRun();
    expect(draftPuts).toBeGreaterThan(0);

    leavePage();
    expect(await screen.findByRole("alertdialog")).toHaveTextContent("1 listing has unsaved changes");
  }, 20_000);

  it("deleting a photo of a copied listing counts as unsaved", async () => {
    await openCopy();
    fireEvent.click(screen.getByRole("button", { name: "Remove photo 1" }));
    await letAutosaveRun();

    leavePage();
    expect(await screen.findByRole("alertdialog")).toBeInTheDocument();
  }, 20_000);

  it("a variation edit counts as unsaved", async () => {
    await openNew();
    const variations = section("Variations");
    await waitFor(() => expect(variations.getByRole("combobox", { name: "Category" })).toBeInTheDocument());
    fireEvent.change(variations.getByRole("combobox", { name: "Category" }), { target: { value: "1" } });
    await letAutosaveRun();

    leavePage();
    expect(await screen.findByRole("alertdialog")).toBeInTheDocument();
  }, 20_000);

  it("a successful Save draft clears the warning", async () => {
    await openNew();
    fireEvent.change(section("Title").getByPlaceholderText("e.g. Miami Skyline Wall Art Print"), {
      target: { value: "Cat shirt" },
    });
    await letAutosaveRun();

    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    await waitFor(() => expect(screen.getByText("Saved")).toBeInTheDocument());

    const anchor = leavePage();
    await letAutosaveRun();
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    anchor.remove();
  }, 20_000);

  it("Save draft and leave saves, then carries on", async () => {
    await openNew();
    fireEvent.change(section("Title").getByPlaceholderText("e.g. Miami Skyline Wall Art Print"), {
      target: { value: "Cat shirt" },
    });

    leavePage();
    await screen.findByRole("alertdialog");
    const before = draftPuts;
    fireEvent.click(screen.getByRole("button", { name: "Save draft and leave" }));

    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(draftPuts).toBeGreaterThan(before);
  }, 20_000);
});
