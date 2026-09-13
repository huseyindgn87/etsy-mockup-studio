// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import ShopButton from "../ShopButton";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ShopButton", () => {
  it("shows a skeleton before the shop name loads, then a single button with the real name", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ shopName: "GHCollectiveUS" }),
      }),
    );

    render(<ShopButton />);
    expect(screen.getByRole("status", { name: "Loading shop name" })).toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();

    const link = await screen.findByRole("link", { name: "GHCollectiveUS" });
    expect(link).toHaveAttribute("href", "/listings");
    expect(screen.getAllByRole("link")).toHaveLength(1);
  });

  it("falls back to a generic label when the fetch fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }));

    render(<ShopButton />);
    const link = await screen.findByRole("link", { name: "My shop" });
    expect(link).toHaveAttribute("href", "/listings");
  });
});
