// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import NavBar from "../NavBar";

vi.mock("next/navigation", () => ({
  usePathname: () => "/listings",
}));

describe("NavBar", () => {
  it("does not expose the mockup studio as a top-level nav entry", () => {
    render(<NavBar shopName="GHCollectiveUS" />);

    expect(screen.queryByRole("link", { name: "Mockups" })).not.toBeInTheDocument();
    for (const link of screen.getAllByRole("link")) {
      expect(link.getAttribute("href")).not.toMatch(/^\/mockups/);
    }
  });

  it("still links to Listings", () => {
    render(<NavBar shopName={null} />);
    expect(screen.getByRole("link", { name: "Listings" })).toHaveAttribute("href", "/listings");
  });
});
