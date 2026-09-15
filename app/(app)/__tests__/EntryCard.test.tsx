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

    render(<EntryCard etsyConnected />);
    await screen.findByRole("link", { name: "GHCollectiveUS" });

    expect(screen.queryByText(/Etsy user id/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/token expires/i)).not.toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/\d{2}:\d{2}:\d{2}/);
  });

  it("shows the greeting and the shop button, but no Disconnect (that lives only on /settings), when Etsy is connected", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ shopName: "GHCollectiveUS" }) }),
    );

    render(<EntryCard etsyConnected />);
    expect(screen.getByRole("heading", { name: "Welcome back" })).toBeInTheDocument();
    await screen.findByRole("link", { name: "GHCollectiveUS" });
    expect(screen.queryByRole("button", { name: "Disconnect" })).not.toBeInTheDocument();
  });

  it("shows a Connect Etsy shop button, and no shop button or Disconnect, when not connected", () => {
    render(<EntryCard etsyConnected={false} />);

    expect(screen.getByRole("link", { name: "Connect Etsy shop" })).toHaveAttribute(
      "href",
      "/api/auth/etsy/login",
    );
    expect(screen.queryByRole("button", { name: "Disconnect" })).not.toBeInTheDocument();
  });

  it("never renders the app name or legacy connect-your-account copy on the card", () => {
    render(<EntryCard etsyConnected={false} />);
    expect(document.body.textContent).not.toMatch(/etsy mockup studio|listhouse/i);
    expect(screen.queryByText(/connect your etsy account/i)).not.toBeInTheDocument();
  });
});
