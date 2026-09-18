// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EDITOR_SECTIONS, topmostVisibleSection, type EditorSection } from "../editor-sections";

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

type ObserverCallback = (entries: Partial<IntersectionObserverEntry>[]) => void;
let observers: { callback: ObserverCallback; targets: Element[] }[] = [];

class FakeIntersectionObserver {
  private entry: { callback: ObserverCallback; targets: Element[] };
  constructor(callback: ObserverCallback) {
    this.entry = { callback, targets: [] };
    observers.push(this.entry);
  }
  observe(el: Element) {
    this.entry.targets.push(el);
  }
  unobserve() {}
  disconnect() {
    observers = observers.filter((o) => o !== this.entry);
  }
  takeRecords() {
    return [];
  }
}

/** Reports the given sections as in/out of view to the live observer. */
function intersect(changes: Partial<Record<EditorSection, boolean>>) {
  const observer = observers.at(-1)!;
  act(() =>
    observer.callback(
      Object.entries(changes).map(([key, isIntersecting]) => ({
        target: document.querySelector(`[data-editor-section="${key}"]`)!,
        isIntersecting,
      })),
    ),
  );
}

let scrollIntoView: ReturnType<typeof vi.fn>;
let reducedMotion = false;

beforeEach(() => {
  nav.params = new URLSearchParams();
  observers = [];
  reducedMotion = false;
  window.history.replaceState(null, "", "/mockups");
  scrollIntoView = vi.fn();
  Element.prototype.scrollIntoView = scrollIntoView as unknown as Element["scrollIntoView"];
  vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({ matches: query.includes("reduced-motion") && reducedMotion, media: query })),
  );
  URL.createObjectURL = vi.fn(() => "blob:photo");
  URL.revokeObjectURL = vi.fn();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ error: "not mocked" }), { status: 404 })),
  );
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const sidebar = () => within(screen.getByRole("navigation", { name: "Listing sections" }));
const link = (label: string) => sidebar().getByRole("link", { name: new RegExp(`^${label}`) });
const region = (label: string) => screen.getByRole("region", { name: label });
const heading = (label: string) => within(region(label)).getByRole("heading", { name: label });

/** Which element each `scrollIntoView` call was made on, and how. */
const scrolls = () =>
  scrollIntoView.mock.contexts.map((el, i) => ({
    section: (el as HTMLElement).dataset.editorSection,
    options: scrollIntoView.mock.calls[i][0],
  }));

describe("listing editor as one scrolling form", () => {
  it("renders every section at once, in sidebar order, each with a heading and anchor", () => {
    render(<ToastProvider><MockupsPage /></ToastProvider>);

    const sections = [...document.querySelectorAll<HTMLElement>("[data-editor-section]")];
    expect(sections.map((s) => s.dataset.editorSection)).toEqual(EDITOR_SECTIONS.map((s) => s.key));
    for (const { label, anchor } of EDITOR_SECTIONS) {
      expect(region(label)).toHaveAttribute("id", anchor);
      expect(heading(label)).toBeInTheDocument();
      expect(link(label)).toHaveAttribute("href", `#${anchor}`);
    }
    expect(within(region("Title")).getByPlaceholderText("e.g. Miami Skyline Wall Art Print")).toBeInTheDocument();
    expect(within(region("Settings")).getByRole("radio", { name: "Automatic" })).toBeInTheDocument();
  });

  it("scrolls to a section from the sidebar, focuses its heading and keeps every section mounted", () => {
    render(<ToastProvider><MockupsPage /></ToastProvider>);
    const shippingLink = link("Shipping");
    shippingLink.focus();
    expect(shippingLink).toHaveFocus();

    fireEvent.click(shippingLink);

    expect(scrolls()).toEqual([{ section: "shipping", options: { behavior: "smooth", block: "start" } }]);
    expect(heading("Shipping")).toHaveFocus();
    expect(window.location.hash).toBe("#shipping");
    expect(shippingLink).toHaveAttribute("aria-current", "location");
    expect(document.querySelectorAll("[data-editor-section]")).toHaveLength(EDITOR_SECTIONS.length);
    expect(within(region("Title")).getByPlaceholderText("e.g. Miami Skyline Wall Art Print")).toBeInTheDocument();
  });

  it("jumps instantly when the user prefers reduced motion", () => {
    reducedMotion = true;
    render(<ToastProvider><MockupsPage /></ToastProvider>);

    fireEvent.click(link("How it's made"));

    expect(scrolls()).toEqual([{ section: "howMade", options: { behavior: "auto", block: "start" } }]);
    expect(heading("How it's made")).toHaveFocus();
    expect(window.location.hash).toBe("#how-its-made");
  });

  it("scrolls to the section named by the URL hash on mount", async () => {
    window.history.replaceState(null, "", "/mockups#personalization");
    render(<ToastProvider><MockupsPage /></ToastProvider>);

    await waitFor(() => expect(scrolls().map((s) => s.section)).toEqual(["personalization"]));
    expect(heading("Personalization")).toHaveFocus();
    expect(link("Personalization")).toHaveAttribute("aria-current", "location");
  });

  it("ignores a hash that isn't a section", () => {
    window.history.replaceState(null, "", "/mockups#nope");
    render(<ToastProvider><MockupsPage /></ToastProvider>);

    expect(scrollIntoView).not.toHaveBeenCalled();
    expect(link("Photos")).toHaveAttribute("aria-current", "location");
  });

  it("highlights the topmost section in view as the page scrolls", () => {
    render(<ToastProvider><MockupsPage /></ToastProvider>);
    const observed = observers.at(-1)!.targets.map((t) => (t as HTMLElement).dataset.editorSection);
    expect(observed).toEqual(EDITOR_SECTIONS.map((s) => s.key));
    const current = () => sidebar().getAllByRole("link").filter((a) => a.getAttribute("aria-current") === "location");

    intersect({ photos: false, description: true, title: true });
    expect(current()).toEqual([link("Title")]);

    intersect({ title: false, tags: true });
    expect(current()).toEqual([link("Description")]);

    // Entries arrive in any order — sidebar order decides.
    intersect({ description: false, settings: true, details: true, shipping: true });
    expect(current()).toEqual([link("Tags")]);

    intersect({ tags: false, details: false });
    expect(current()).toEqual([link("Shipping")]);

    // Nothing reported in view (e.g. the spacer below the last section) keeps the last highlight.
    intersect({ shipping: false, settings: false });
    expect(current()).toEqual([link("Shipping")]);
  });

  it("on a refused save, scrolls to the first section with an error and marks every errored section", async () => {
    render(<ToastProvider><MockupsPage /></ToastProvider>);
    fireEvent.change(screen.getByTestId("photo-file-input"), {
      target: { files: [new File(["x"], "shirt.jpg", { type: "image/jpeg" })] },
    });
    const publish = await screen.findByRole("button", { name: "Create draft & upload (1)" });
    expect(publish).toBeEnabled();

    fireEvent.click(publish);

    expect(scrolls()).toEqual([{ section: "title", options: { behavior: "smooth", block: "start" } }]);
    expect(heading("Title")).toHaveFocus();
    expect(screen.getByText("Enter a title for the new draft (Title section).")).toBeInTheDocument();
    const errored = () =>
      EDITOR_SECTIONS.filter((s) => sidebar().queryByRole("img", { name: `${s.label} has errors` })).map((s) => s.key);
    expect(errored()).toEqual(["title", "details", "shipping"]);

    // Fixing a section clears its mark straight away; the next refused save jumps to the next one down.
    fireEvent.change(within(region("Title")).getByPlaceholderText("e.g. Miami Skyline Wall Art Print"), {
      target: { value: "Miami Skyline Wall Art Print" },
    });
    expect(errored()).toEqual(["details", "shipping"]);

    scrollIntoView.mockClear();
    fireEvent.click(publish);
    expect(scrolls().map((s) => s.section)).toEqual(["details"]);
    expect(heading("Details")).toHaveFocus();
    expect(screen.getByText("Choose a category for the new listing (Details section).")).toBeInTheDocument();
    expect(link("Details")).toHaveAttribute("data-errored", "true");
    expect(link("Title")).not.toHaveAttribute("data-errored");
  });
});

describe("topmostVisibleSection", () => {
  it("picks the first visible section in sidebar order, or null when none are", () => {
    expect(topmostVisibleSection(new Set<EditorSection>(["settings", "price", "tags"]))).toBe("tags");
    expect(topmostVisibleSection(new Set())).toBeNull();
  });
});
