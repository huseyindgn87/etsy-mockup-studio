// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/etsy/auth", () => ({ getEtsySession: vi.fn().mockResolvedValue(null) }));
vi.mock("../EntryCard", () => ({ default: () => <div>entry card</div> }));

import Home from "../page";

describe("Home — welcome card", () => {
  it("keeps its glass styling but has no sheen/shimmer effect", async () => {
    render(await Home({ searchParams: Promise.resolve({}) }));
    const card = screen.getByRole("main");

    expect(card).toHaveClass("rounded-card", "bg-surface", "backdrop-blur-md", "shadow-soft");
    // `entry-card` was the class that carried the diagonal ::before sheen (now deleted from app/globals.css).
    expect(card).not.toHaveClass("entry-card");
    expect(card.className).not.toMatch(/animate-/);
  });
});
