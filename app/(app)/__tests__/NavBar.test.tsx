// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { usePathname } from "next/navigation";
import NavBar from "../NavBar";

vi.mock("next/navigation", () => ({
  usePathname: vi.fn(),
}));

const mockedUsePathname = vi.mocked(usePathname);
const EMAIL = "seller@example.com";

describe("NavBar", () => {
  describe("lobby state (pathname \"/\")", () => {
    it("renders the wordmark as plain, non-interactive text", () => {
      mockedUsePathname.mockReturnValue("/");
      render(<NavBar email={EMAIL} shopName={null} etsySession={null} />);

      expect(screen.queryByRole("link", { name: /Etsy Mockup Studio/i })).not.toBeInTheDocument();
      const wordmark = screen.getByText("Etsy Mockup Studio");
      expect(wordmark.tagName).toBe("SPAN");
      expect(wordmark).not.toHaveAttribute("tabindex");
      expect(wordmark).not.toHaveAttribute("href");
    });

    it("does not show the Listings nav link", () => {
      mockedUsePathname.mockReturnValue("/");
      render(<NavBar email={EMAIL} shopName={null} etsySession={null} />);
      expect(screen.queryByRole("link", { name: "Listings" })).not.toBeInTheDocument();
    });
  });

  describe("inside state (any other pathname)", () => {
    it("renders the wordmark as a link back to the lobby", () => {
      mockedUsePathname.mockReturnValue("/listings");
      render(<NavBar email={EMAIL} shopName={null} etsySession={null} />);

      const wordmark = screen.getByRole("link", { name: "Back to shop selection" });
      expect(wordmark).toHaveAttribute("href", "/");
    });

    it("does not expose the mockup studio as a top-level nav entry", () => {
      mockedUsePathname.mockReturnValue("/listings");
      render(<NavBar email={EMAIL} shopName="GHCollectiveUS" etsySession={null} />);

      expect(screen.queryByRole("link", { name: "Mockups" })).not.toBeInTheDocument();
      for (const link of screen.getAllByRole("link")) {
        expect(link.getAttribute("href")).not.toMatch(/^\/mockups/);
      }
    });

    it("still links to Listings", () => {
      mockedUsePathname.mockReturnValue("/listings");
      render(<NavBar email={EMAIL} shopName={null} etsySession={null} />);
      expect(screen.getByRole("link", { name: "Listings" })).toHaveAttribute("href", "/listings");
    });
  });

  describe("Etsy connection chrome", () => {
    it("hides the Connected pill and Disconnect button when Etsy isn't connected", () => {
      mockedUsePathname.mockReturnValue("/");
      render(<NavBar email={EMAIL} shopName={null} etsySession={null} />);
      expect(screen.queryByRole("button", { name: /Connected/i })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Disconnect" })).not.toBeInTheDocument();
    });

    it("shows the Connected pill and Disconnect button when Etsy is connected", () => {
      mockedUsePathname.mockReturnValue("/");
      render(
        <NavBar
          email={EMAIL}
          shopName={null}
          etsySession={{ userId: "e1", expiresAt: Date.now() + 60_000 }}
        />,
      );
      expect(screen.getByRole("button", { name: /Connected/i })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Disconnect" })).toBeInTheDocument();
    });
  });
});
