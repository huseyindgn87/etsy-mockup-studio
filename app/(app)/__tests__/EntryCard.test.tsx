// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import EntryCard from "../EntryCard";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("EntryCard", () => {
  it("never renders a raw Etsy user id or token expiry in the card body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ shopName: "GHCollectiveUS" }),
      }),
    );

    render(<EntryCard />);
    await screen.findByRole("link", { name: "GHCollectiveUS" });

    expect(screen.queryByText(/Etsy user id/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/token expires/i)).not.toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/\d{2}:\d{2}:\d{2}/);
  });

  it("shows the greeting, the shop button, and a quiet Disconnect link", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ shopName: "GHCollectiveUS" }) }),
    );

    render(<EntryCard />);
    expect(screen.getByRole("heading", { name: "Welcome back" })).toBeInTheDocument();
    await screen.findByRole("link", { name: "GHCollectiveUS" });
    expect(screen.getByRole("button", { name: "Disconnect" })).toBeInTheDocument();
  });
});
