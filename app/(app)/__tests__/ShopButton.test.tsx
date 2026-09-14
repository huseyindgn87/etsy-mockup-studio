// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import ShopButton from "../ShopButton";

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubShop(body: { shopName?: string } | null, ok = true) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok,
      json: async () => body ?? {},
    }),
  );
}

describe("ShopButton", () => {
  it("shows a skeleton before the shop name loads, then a single button with the real name", async () => {
    stubShop({ shopName: "GHCollectiveUS" });

    render(<ShopButton />);
    expect(screen.getByRole("status", { name: "Loading shop name" })).toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();

    const link = await screen.findByRole("link", { name: "GHCollectiveUS" });
    expect(link).toHaveAttribute("href", "/listings");
    expect(screen.getAllByRole("link")).toHaveLength(1);
  });

  it("falls back to a generic label when the fetch fails", async () => {
    stubShop(null, false);

    render(<ShopButton />);
    const link = await screen.findByRole("link", { name: "My shop" });
    expect(link).toHaveAttribute("href", "/listings");
  });

  it("shows a small marketplace badge alongside the button", async () => {
    stubShop({ shopName: "GHCollectiveUS" });

    render(<ShopButton />);
    await screen.findByRole("link", { name: "GHCollectiveUS" });
    expect(screen.getByText("Etsy")).toBeInTheDocument();
  });

  it("sets --mx/--my custom properties on pointer move and clears the glow on leave", async () => {
    stubShop({ shopName: "GHCollectiveUS" });

    render(<ShopButton />);
    const link = await screen.findByRole("link", { name: "GHCollectiveUS" });
    const glow = screen.getByTestId("shop-button-glow");

    expect(glow).toHaveStyle({ opacity: "0" });

    fireEvent.pointerEnter(link, { pointerType: "mouse" });
    fireEvent.pointerMove(link, { pointerType: "mouse", clientX: 40, clientY: 12 });

    expect(link.style.getPropertyValue("--mx")).toBe("40px");
    expect(link.style.getPropertyValue("--my")).toBe("12px");
    expect(glow).toHaveStyle({ opacity: "1" });

    fireEvent.pointerLeave(link, { pointerType: "mouse" });
    expect(glow).toHaveStyle({ opacity: "0" });
  });

  it("never activates the glow for touch pointers", async () => {
    stubShop({ shopName: "GHCollectiveUS" });

    render(<ShopButton />);
    const link = await screen.findByRole("link", { name: "GHCollectiveUS" });
    const glow = screen.getByTestId("shop-button-glow");

    fireEvent.pointerEnter(link, { pointerType: "touch" });
    fireEvent.pointerMove(link, { pointerType: "touch", clientX: 40, clientY: 12 });

    expect(glow).toHaveStyle({ opacity: "0" });
  });
});
