// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  listingFormFromSource,
  sourceFromCache,
  type CachedListingRow,
} from "@/lib/etsy/listing-editor-form";

const LISTING_ID = 4440391068;
const TITLE = "Happy Meowentine Cats T-Shirt, Valentine Gift for Cat Lovers";

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
import { ToastProvider } from "@/app/components/toast/ToastProvider";

/** A cached `Listing` row, as the listings cache holds HG-000179 (trimmed to 2×2 combinations). */
const CACHED_ROW: CachedListingRow = {
  listingId: String(LISTING_ID),
  title: TITLE,
  description: "This is for ONE shirt, not a set of 2.",
  tags: ["meowentine shirt", "cat lover shirt"],
  materials: [],
  quantity: 997,
  sku: "HG-000179",
  shopSectionId: 56595398,
  shippingProfileId: null,
  returnPolicyId: null,
  whoMade: "someone_else",
  whenMade: "made_to_order",
  isSupply: false,
  priceAmount: 2369,
  priceDivisor: 100,
  isPersonalizable: false,
  personalizationIsRequired: false,
  personalizationInstructions: null,
  personalizationCharCountMax: null,
  inventoryProperties: [
    {
      etsyPropertyId: "513",
      name: "Size",
      scaleId: null,
      rank: 0,
      priceOnProperty: true,
      quantityOnProperty: false,
      skuOnProperty: false,
      values: [
        { id: "v-s", etsyValueId: "399983730245", value: "Unisex Shirt / S", rank: 0 },
        { id: "v-2xl", etsyValueId: "390589685320", value: "Unisex Shirt / 2XL", rank: 1 },
      ],
    },
    {
      etsyPropertyId: "514",
      name: "Color",
      scaleId: null,
      rank: 1,
      priceOnProperty: false,
      quantityOnProperty: false,
      skuOnProperty: false,
      values: [
        { id: "v-ash", etsyValueId: "89818396547", value: "Ash", rank: 0 },
        { id: "v-black", etsyValueId: "50308703618", value: "Black", rank: 1 },
      ],
    },
  ],
  inventoryProducts: [
    ["v-s", "v-ash", 2369, true],
    ["v-s", "v-black", 2369, true],
    ["v-2xl", "v-ash", 2678, true],
    ["v-2xl", "v-black", 2678, false],
  ].map(([size, color, amount, enabled]) => ({
    sku: "HG-000179",
    priceAmount: amount as number,
    priceDivisor: 100,
    quantity: 997,
    isEnabled: enabled as boolean,
    readinessStateId: "1441577564343",
    values: [{ valueId: size as string }, { valueId: color as string }],
  })),
};

/** What `GET /api/etsy/listings/[id]/editor` returns for that row. */
const HYDRATED_FORM = listingFormFromSource({
  ...sourceFromCache(CACHED_ROW),
  taxonomyId: 482,
  taxonomyPath: "Clothing > Gender-Neutral Adult Clothing > Tops & Tees > T-shirts",
  attributes: [{ propertyId: 200, propertyName: "Primary color", scaleId: null, valueIds: [1], values: ["Black"] }],
  productionPartnerIds: [7],
  featured: true,
  autoRenew: false,
});

interface Call {
  method: string;
  url: string;
  body?: unknown;
}
let calls: Call[] = [];
let saveResponse: () => Response;
type Media = { images: { imageId: number; url: string; rank: number; altText: string }[]; videos: never[] };
/** The listing's photos as Etsy has them — what `GET /api/etsy/listings/bulk?ids=` answers. */
let etsyMedia: Media;
/** What the photo save (`POST /api/mockups/render`) leaves on Etsy. */
let afterPhotoSave: (() => Media) | null;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function route(method: string, url: string): Response {
  if (url === `/api/etsy/listings/${LISTING_ID}/editor`) return json({ form: HYDRATED_FORM, source: "cache", warning: null });
  if (url.startsWith("/api/etsy/listings/bulk?ids=")) return json({ listings: [etsyMedia], missing: [] });
  if (method === "POST" && url === "/api/mockups/render") {
    if (afterPhotoSave) etsyMedia = afterPhotoSave();
    return json({ mode: "existing", listingId: LISTING_ID, uploaded: [], failed: [], skipped: 0, edited: true });
  }
  if (url === "/api/etsy/shop") return json({ shopName: "GHCollectiveUS" });
  if (url === "/api/etsy/sections") return json({ sections: [{ shopSectionId: 56595398, title: "Valentine's Day" }] });
  if (url === "/api/etsy/processing-profiles") {
    return json({
      profiles: [
        { readinessStateId: 1441577564343, readinessState: "made_to_order", minProcessingDays: 1, maxProcessingDays: 3, displayLabel: "1-3 days" },
      ],
    });
  }
  if (url === "/api/etsy/production-partners") {
    return json({ partners: [{ productionPartnerId: 7, partnerName: "Atlanta Print Co", location: "US" }] });
  }
  if (url === "/api/etsy/taxonomy") {
    const node = (id: number, level: number, name: string, parentId: number | null, children: unknown[] = []) => ({
      id, level, name, parentId, children,
    });
    return json({
      tree: [
        node(1, 1, "Clothing", null, [
          node(2, 2, "Gender-Neutral Adult Clothing", 1, [node(3, 3, "Tops & Tees", 2, [node(482, 4, "T-shirts", 3)])]),
        ]),
      ],
    });
  }
  if (url === "/api/etsy/taxonomy/482/properties") {
    return json({
      properties: [
        {
          propertyId: 200,
          name: "color",
          displayName: "Primary color",
          isRequired: false,
          isMultivalued: false,
          maxValuesAllowed: null,
          supportsAttributes: true,
          supportsVariations: false,
          scales: [],
          possibleValues: [
            { valueId: 1, name: "Black", scaleId: null },
            { valueId: 2, name: "White", scaleId: null },
          ],
        },
      ],
    });
  }
  if (method === "POST" && url === "/api/etsy/listings/bulk/save") return saveResponse();
  if (method === "POST" && url === "/api/drafts") return json({ id: "draft-1" });
  if (method === "PUT" && url === "/api/drafts/draft-1") return json({ id: "draft-1" });
  if (method === "GET" && url === "/api/drafts/draft-1") {
    return json({
      id: "draft-1",
      formData: HYDRATED_FORM,
      source: { mode: "existing", listingId: LISTING_ID },
      activeTab: "photos",
      imageOrder: [],
      removedJobKeys: [],
      removedEtsyImageIds: [],
      altTextBySlot: {},
      videos: null,
      mockups: [],
      designs: [],
      ownImages: [],
    });
  }
  if (url.startsWith("/api/schedule")) return json({ scheduledListings: [] });
  return json({ error: "not mocked" }, 404);
}

beforeEach(() => {
  calls = [];
  saveResponse = () => json({ results: [{ listingId: LISTING_ID, ok: true }] });
  etsyMedia = { images: [], videos: [] };
  afterPhotoSave = null;
  Element.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = (init?.method ?? "GET").toUpperCase();
      const body =
        typeof init?.body === "string"
          ? JSON.parse(init.body)
          : init?.body instanceof FormData
            ? JSON.parse(String(init.body.get("payload")))
            : undefined;
      calls.push({ method, url, body });
      return route(method, url);
    }),
  );
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const openExisting = () => {
  nav.params = new URLSearchParams({ mode: "existing", listingId: String(LISTING_ID), title: TITLE });
  return render(<ToastProvider><MockupsPage /></ToastProvider>);
};

const draftWrites = () => calls.filter((c) => c.url.startsWith("/api/drafts") && c.method !== "GET");

/** Every section is on the page at once; the sidebar link just scrolls to it. */
function openSection(label: string) {
  fireEvent.click(within(screen.getByRole("navigation")).getByRole("link", { name: new RegExp(`^${label}`) }));
  return within(screen.getByRole("region", { name: label }));
}

const header = () => screen.getByRole("banner");

describe("editor opened on an existing listing", () => {
  it("hydrates every section from the cached listing", async () => {
    openExisting();

    await waitFor(() => expect(within(header()).queryByText("Loading listing…")).not.toBeInTheDocument());
    expect(within(header()).getByText(TITLE)).toBeInTheDocument();
    expect(within(header()).queryByText("Untitled listing")).not.toBeInTheDocument();

    const title = openSection("Title");
    expect(title.getByPlaceholderText("e.g. Miami Skyline Wall Art Print")).toHaveValue(TITLE);

    const description = openSection("Description");
    expect(description.getByPlaceholderText("Describe the product…")).toHaveValue("This is for ONE shirt, not a set of 2.");

    const tags = openSection("Tags");
    expect(tags.getByText("meowentine shirt")).toBeInTheDocument();
    expect(tags.getByText("cat lover shirt")).toBeInTheDocument();

    const details = openSection("Details");
    expect(details.getByText("Clothing > Gender-Neutral Adult Clothing > Tops & Tees > T-shirts")).toBeInTheDocument();
    await waitFor(() => expect(details.getByRole("checkbox", { name: "Black" })).toBeChecked());
    expect(details.getByRole("checkbox", { name: "White" })).not.toBeChecked();

    const howMade = openSection("How it's made");
    expect(howMade.getByRole("radio", { name: "Another company or person" })).toBeChecked();
    await waitFor(() => expect(howMade.getByRole("checkbox", { name: /Atlanta Print Co/ })).toBeChecked());

    expect(openSection("Price").getByText(/Price varies by variation/)).toBeInTheDocument();

    const inventory = openSection("Inventory");
    expect(inventory.getByRole("spinbutton")).toHaveValue(997);
    expect(inventory.getByPlaceholderText("optional")).toHaveValue("HG-000179");

    const variations = openSection("Variations");
    await waitFor(() => expect(variations.getByRole("combobox", { name: "Item type" })).toHaveValue("482"));
    expect(variations.getByRole("combobox", { name: "Category" })).toHaveValue("1");
    expect(variations.getByRole("textbox", { name: "First variation name" })).toHaveValue("Size");
    expect(variations.getByRole("textbox", { name: "Second variation name" })).toHaveValue("Color");
    const options = (name: string) =>
      within(variations.getByRole("list", { name })).getAllByRole("listitem").map((li) => li.textContent);
    expect(options("Size options")).toEqual(["⠿Unisex Shirt / S×", "⠿Unisex Shirt / 2XL×"]);
    expect(options("Color options")).toEqual(["⠿Ash×", "⠿Black×"]);
    expect(variations.getByText(/^4 combinations \(max \d+\)\.$/)).toBeInTheDocument();

    const shipping = openSection("Shipping");
    await waitFor(() => expect(shipping.getByRole("combobox")).toHaveValue("1441577564343"));

    const settings = openSection("Settings");
    await waitFor(() => expect(settings.getAllByRole("combobox")[0]).toHaveValue("56595398"));
    expect(settings.getByRole("checkbox", { name: /Feature this listing/ })).toBeChecked();
    expect(settings.getByRole("radio", { name: "Automatic" })).not.toBeChecked();
  });

  it("offers View on Etsy beside Save draft and Preview", async () => {
    openExisting();
    await waitFor(() => expect(within(header()).getByText(TITLE)).toBeInTheDocument());

    const view = within(header()).getByRole("link", { name: "View on Etsy" });
    expect(view).toHaveAttribute("href", `https://www.etsy.com/listing/${LISTING_ID}`);
    expect(view).toHaveAttribute("target", "_blank");
    expect(view).toHaveAttribute("rel", expect.stringContaining("noopener"));
    expect(view.querySelector("svg")).not.toBeNull();

    const bar = within(header()).getByText("Save draft").parentElement!;
    const labels = [...bar.children].map((el) => el.textContent);
    expect(labels).toContain("Preview");
    expect(labels.indexOf("View on Etsy")).toBe(labels.indexOf("Preview") + 1);
  });

  it("sends no draft PUT between mount and the first user edit", async () => {
    openExisting();
    await waitFor(() => expect(within(header()).getByText(TITLE)).toBeInTheDocument());
    await waitFor(() => expect(calls.some((c) => c.url.startsWith("/api/etsy/listings/bulk"))).toBe(true));

    // Past the 2 s autosave debounce, twice over.
    await act(() => new Promise((resolve) => setTimeout(resolve, 4500)));
    expect(draftWrites()).toEqual([]);

    fireEvent.change(openSection("Title").getByPlaceholderText("e.g. Miami Skyline Wall Art Print"), {
      target: { value: `${TITLE}!` },
    });
    await waitFor(() => expect(calls.filter((c) => c.method === "PUT" && c.url === "/api/drafts/draft-1")).toHaveLength(1), {
      timeout: 5000,
    });
  }, 20_000);

  it("sends no draft PUT when a saved draft of it is reopened", async () => {
    nav.params = new URLSearchParams({ draftId: "draft-1" });
    render(<ToastProvider><MockupsPage /></ToastProvider>);
    await waitFor(() => expect(within(header()).getByText(TITLE)).toBeInTheDocument());

    await act(() => new Promise((resolve) => setTimeout(resolve, 4500)));
    expect(draftWrites()).toEqual([]);
  }, 20_000);

  describe("Sync to Etsy", () => {
    const syncButton = () => within(header()).getByRole("button", { name: "Sync to Etsy" });
    const saves = () => calls.filter((c) => c.method === "POST" && c.url === "/api/etsy/listings/bulk/save");
    const warnsOnLeave = () => {
      const event = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    };
    const editTitle = async () => {
      await waitFor(() => expect(within(header()).queryByText("Loading listing…")).not.toBeInTheDocument());
      await waitFor(() => expect(screen.getByRole("region", { name: "Title" })).toBeInTheDocument());
      fireEvent.change(openSection("Title").getByPlaceholderText("e.g. Miami Skyline Wall Art Print"), {
        target: { value: `${TITLE}!` },
      });
      await waitFor(() => expect(warnsOnLeave()).toBe(true));
    };

    it("sends only the changed fields through the bulk save route and clears the unsaved state", async () => {
      openExisting();
      await editTitle();

      fireEvent.click(syncButton());
      expect(within(header()).getByRole("button", { name: "Syncing…" })).toBeDisabled();

      await waitFor(() => expect(screen.getByText("Synced to Etsy.")).toBeInTheDocument());
      expect(saves()).toHaveLength(1);
      expect(saves()[0].body).toEqual({ updates: [{ listingId: LISTING_ID, patch: { title: `${TITLE}!` } }] });
      expect(syncButton()).toBeEnabled();
      expect(warnsOnLeave()).toBe(false);
    });

    it("reports a failure and keeps the unsaved state", async () => {
      saveResponse = () => json({ results: [{ listingId: LISTING_ID, ok: false, error: "Etsy refused the title." }] });
      openExisting();
      await editTitle();

      fireEvent.click(syncButton());

      await waitFor(() => expect(screen.getByText("Sync to Etsy failed: Etsy refused the title.")).toBeInTheDocument());
      expect(screen.queryByText("Synced to Etsy.")).not.toBeInTheDocument();
      expect(syncButton()).toBeEnabled();
      expect(warnsOnLeave()).toBe(true);
    });

    const photo = (imageId: number, rank: number, altText: string) => ({
      imageId,
      url: `https://img.etsy/${imageId}.jpg`,
      rank,
      altText,
    });
    const photoSaves = () => calls.filter((c) => c.method === "POST" && c.url === "/api/mockups/render");
    const openWithPhotos = async () => {
      etsyMedia = { images: [photo(1, 1, "Front"), photo(2, 2, "Back")], videos: [] };
      openExisting();
      await waitFor(() => expect(within(header()).queryByText("Loading listing…")).not.toBeInTheDocument());
      const photos = within(screen.getByRole("list", { name: "Listing photos" }));
      await waitFor(() => expect(photos.getAllByRole("listitem").length).toBeGreaterThanOrEqual(2));
      return photos;
    };

    it("sends a photo reorder to Etsy instead of saying nothing changed", async () => {
      const photos = await openWithPhotos();
      await waitFor(() => expect(photos.getByRole("button", { name: "Move photo 1 right" })).toBeInTheDocument());
      fireEvent.click(photos.getByRole("button", { name: "Move photo 1 right" }));
      await waitFor(() => expect(warnsOnLeave()).toBe(true));
      afterPhotoSave = () => ({ images: [photo(2, 1, "Back"), photo(1, 2, "Front")], videos: [] });

      fireEvent.click(syncButton());

      await waitFor(() => expect(screen.getByText("Synced to Etsy.")).toBeInTheDocument());
      expect(screen.queryByText(/Nothing to sync/)).not.toBeInTheDocument();
      expect(photoSaves()).toHaveLength(1);
      expect(photoSaves()[0].body).toMatchObject({
        editExisting: true,
        imageOrder: [
          { kind: "etsy", imageId: 2, altText: "Back" },
          { kind: "etsy", imageId: 1, altText: "Front" },
        ],
      });
      expect(saves()).toHaveLength(0);
      await waitFor(() => expect(warnsOnLeave()).toBe(false));

      // Etsy now holds that order, so a second Sync has nothing left to send.
      fireEvent.click(syncButton());
      await waitFor(() => expect(screen.getByText(/Nothing to sync/)).toBeInTheDocument());
      expect(photoSaves()).toHaveLength(1);
    });

    it("sends an alt text edit to Etsy", async () => {
      const photos = await openWithPhotos();
      fireEvent.click(photos.getByRole("button", { name: "Alt text for photo 2" }));
      fireEvent.change(screen.getByPlaceholderText("Describe this image for screen readers and search…"), {
        target: { value: "Back of the tee" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Close" }));
      await waitFor(() => expect(warnsOnLeave()).toBe(true));

      fireEvent.click(syncButton());

      await waitFor(() => expect(screen.getByText("Synced to Etsy.")).toBeInTheDocument());
      expect(photoSaves()[0].body).toMatchObject({
        imageOrder: [
          { kind: "etsy", imageId: 1, altText: "Front" },
          { kind: "etsy", imageId: 2, altText: "Back of the tee" },
        ],
      });
    });

    it("sends a field change and a photo change together, photos first", async () => {
      const photos = await openWithPhotos();
      fireEvent.click(photos.getByRole("button", { name: "Remove photo 2" }));
      afterPhotoSave = () => ({ images: [photo(1, 1, "Front")], videos: [] });
      fireEvent.change(openSection("Title").getByPlaceholderText("e.g. Miami Skyline Wall Art Print"), {
        target: { value: `${TITLE}!` },
      });

      fireEvent.click(syncButton());

      await waitFor(() => expect(screen.getByText("Synced to Etsy.")).toBeInTheDocument());
      const order = calls.filter((c) => c.method === "POST").map((c) => c.url);
      expect(order.indexOf("/api/mockups/render")).toBeLessThan(order.indexOf("/api/etsy/listings/bulk/save"));
      expect(photoSaves()[0].body).toMatchObject({ imageOrder: [{ kind: "etsy", imageId: 1 }] });
      expect(saves()[0].body).toEqual({ updates: [{ listingId: LISTING_ID, patch: { title: `${TITLE}!` } }] });
    });

    it("names a change Etsy's API can't write instead of skipping it", async () => {
      openExisting();
      await waitFor(() => expect(within(header()).queryByText("Loading listing…")).not.toBeInTheDocument());
      fireEvent.click(openSection("Settings").getByRole("checkbox", { name: /Etsy Ads/ }));
      await waitFor(() => expect(warnsOnLeave()).toBe(true));

      fireEvent.click(syncButton());

      await waitFor(() =>
        expect(screen.getByText(/Not synced to Etsy: Promote with Etsy Ads \(Etsy's Open API has no endpoint/)).toBeInTheDocument(),
      );
      expect(saves()).toHaveLength(0);
      expect(screen.queryByText(/Nothing to sync/)).not.toBeInTheDocument();
      expect(warnsOnLeave()).toBe(true);
    });

    it("counts a difference, not an edit: typing and undoing leaves nothing unsaved", async () => {
      openExisting();
      await editTitle();
      fireEvent.change(openSection("Title").getByPlaceholderText("e.g. Miami Skyline Wall Art Print"), {
        target: { value: TITLE },
      });
      await waitFor(() => expect(warnsOnLeave()).toBe(false));
    });

    it("is not offered for a new listing", async () => {
      nav.params = new URLSearchParams();
      render(<ToastProvider><MockupsPage /></ToastProvider>);
      await waitFor(() => expect(within(header()).getByText("Save draft")).toBeInTheDocument());
      expect(within(header()).queryByRole("button", { name: "Sync to Etsy" })).not.toBeInTheDocument();
      expect(within(header()).queryByRole("link", { name: "View on Etsy" })).not.toBeInTheDocument();
    });

    it("says what Save to Etsy does only once the photo grid is first changed", async () => {
      const photos = await openWithPhotos();
      const notice = /photos and videos become exactly what the grid shows/;
      expect(screen.queryByText(notice)).not.toBeInTheDocument();

      await waitFor(() => expect(photos.getByRole("button", { name: "Move photo 1 right" })).toBeInTheDocument());
      fireEvent.click(photos.getByRole("button", { name: "Move photo 1 right" }));
      expect(screen.getByText(notice)).toBeInTheDocument();

      fireEvent.click(within(screen.getByText(notice).closest("[role=status]") as HTMLElement).getByRole("button", { name: "Dismiss notification" }));
      fireEvent.click(photos.getByRole("button", { name: "Move photo 1 right" }));
      expect(screen.queryByText(notice)).not.toBeInTheDocument();
    });

    it("explains why an existing listing can't be scheduled only when Schedule is pressed", async () => {
      openExisting();
      await waitFor(() => expect(within(header()).queryByText("Loading listing…")).not.toBeInTheDocument());
      const notice = /can't be scheduled/;
      expect(screen.queryByText(notice)).not.toBeInTheDocument();

      fireEvent.click(within(header()).getByRole("button", { name: "Schedule for later" }));
      expect(screen.getByRole("status")).toHaveTextContent(notice);
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
  });
});
