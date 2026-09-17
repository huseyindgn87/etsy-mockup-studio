// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

class FakeIntersectionObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return [];
  }
}

const PROFILE = {
  readinessStateId: 77,
  readinessState: "made_to_order",
  minProcessingDays: 3,
  maxProcessingDays: 5,
  displayLabel: "3 - 5 days",
};

beforeEach(() => {
  nav.params = new URLSearchParams();
  window.history.replaceState(null, "", "/mockups");
  Element.prototype.scrollIntoView = vi.fn() as unknown as Element["scrollIntoView"];
  vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
  vi.stubGlobal("matchMedia", vi.fn((query: string) => ({ matches: false, media: query })));
  URL.createObjectURL = vi.fn(() => "blob:photo");
  URL.revokeObjectURL = vi.fn();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) =>
      url.startsWith("/api/etsy/processing-profiles")
        ? new Response(JSON.stringify({ profiles: [PROFILE] }))
        : new Response(JSON.stringify({ error: "not mocked" }), { status: 404 }),
    ),
  );
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** A listing the editor would let the user schedule: one photo and a processing profile. */
async function readyToSchedule() {
  render(<MockupsPage />);
  fireEvent.change(screen.getByTestId("photo-file-input"), {
    target: { files: [new File(["x"], "shirt.jpg", { type: "image/jpeg" })] },
  });
  const profiles = await screen.findByDisplayValue("Select a processing profile…");
  fireEvent.change(profiles, { target: { value: String(PROFILE.readinessStateId) } });

  const trigger = await screen.findByRole("button", { name: "Schedule for later" });
  await waitFor(() => expect(trigger).toBeEnabled());
  return trigger;
}

describe("the schedule picker in the listing editor", () => {
  it("opens anchored below its button, never above it", async () => {
    const trigger = await readyToSchedule();

    fireEvent.click(trigger);

    const popover = screen.getByRole("dialog");
    // Anchored: it hangs inside the button's own positioned wrapper, after the
    // button — not centred on the page, and not before (above) it.
    expect(trigger.parentElement).toHaveClass("relative");
    expect(popover.parentElement).toBe(trigger.parentElement);
    expect(trigger.compareDocumentPosition(popover) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(popover).toHaveAttribute("data-placement", "below");

    const position = popover.className;
    expect(position).toContain("top-full"); // directly below the button
    expect(position).toContain("right-0"); // aligned to its right edge
    expect(position).toContain("mt-2"); // with a small gap
    expect(position).toContain("z-50"); // above the sticky header
    expect(position).toContain("overflow-y-auto"); // out of room: scrolls itself
    // Nothing that would place it above the button, or make the header clip it.
    expect(position).not.toMatch(/bottom-full|bottom-\[|-translate-y|\bfixed\b/);
    expect(popover).not.toHaveAttribute("aria-modal");
  });

  it("keeps the picker's contents and closing behaviour", async () => {
    const trigger = await readyToSchedule();
    fireEvent.click(trigger);

    const popover = within(screen.getByRole("dialog"));
    expect(popover.getByRole("heading", { name: "Schedule for later" })).toBeInTheDocument();
    expect(popover.getByLabelText("Date")).toHaveAttribute("type", "date");
    expect(popover.getByLabelText("Time")).toHaveAttribute("type", "time");
    expect(popover.getByRole("combobox")).toBeInTheDocument(); // Timezone
    expect(popover.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
    expect(popover.getByRole("button", { name: "Schedule" })).toBeInTheDocument();

    fireEvent.click(popover.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("a press outside it closes it", async () => {
    const trigger = await readyToSchedule();
    fireEvent.click(trigger);
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    fireEvent.pointerDown(document.body);

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
