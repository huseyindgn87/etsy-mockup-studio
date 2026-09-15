// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import type { AnchorHTMLAttributes } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { burstMock } = vi.hoisted(() => ({ burstMock: vi.fn() }));

vi.mock("../dollar-burst", () => ({ burstDollars: burstMock }));
// A plain anchor, so the test sees whether our click handler lets the
// default (navigation) action through.
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import ShopButton from "../ShopButton";

beforeEach(() => {
  burstMock.mockReset();
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ shopName: "GHCollectiveUS" }) }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ShopButton — $ burst", () => {
  it("bursts from the click point without blocking the navigation", async () => {
    render(<ShopButton />);
    const link = await screen.findByRole("link", { name: "GHCollectiveUS" });

    const notPrevented = fireEvent.click(link, { clientX: 64, clientY: 20, detail: 1 });

    expect(notPrevented).toBe(true);
    expect(burstMock).toHaveBeenCalledTimes(1);
    expect(burstMock).toHaveBeenCalledWith(64, 20);
    expect(link).toHaveAttribute("href", "/listings");
  });

  it("bursts from the button's centre on keyboard activation", async () => {
    render(<ShopButton />);
    const link = await screen.findByRole("link", { name: "GHCollectiveUS" });
    link.getBoundingClientRect = () => ({ left: 100, top: 40, width: 200, height: 44 }) as DOMRect;

    fireEvent.click(link, { detail: 0 });
    expect(burstMock).toHaveBeenCalledWith(200, 62);
  });
});
