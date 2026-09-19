// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { usePathname } from "next/navigation";
import NavBar from "../NavBar";
import { LISTINGS_HOME_EVENT, SidebarProvider, useSidebar } from "../SidebarContext";

const { signOutMock } = vi.hoisted(() => ({ signOutMock: vi.fn() }));

vi.mock("next/navigation", () => ({ usePathname: vi.fn() }));
vi.mock("next-auth/react", () => ({ signOut: signOutMock }));

const mockedUsePathname = vi.mocked(usePathname);
const ACCOUNT = { email: "seller@example.com", firstName: null };

/** Stands in for a page that owns the sidebar (the listings page). */
function SidebarProbe() {
  const { open } = useSidebar();
  return <aside id="app-sidebar" hidden={!open} data-testid="sidebar" />;
}

function renderBar(pathname: string, account: typeof ACCOUNT | null = ACCOUNT) {
  mockedUsePathname.mockReturnValue(pathname);
  return render(
    <SidebarProvider>
      <NavBar account={account} />
      <SidebarProbe />
    </SidebarProvider>,
  );
}

beforeEach(() => {
  signOutMock.mockReset();
});

describe("NavBar", () => {
  describe.each(["/", "/listings", "/mockups", "/settings"])("on %s", (pathname) => {
    it("renders no old wordmark, page label, shop name, or email", () => {
      renderBar(pathname);
      const header = screen.getByRole("banner");
      expect(header).not.toHaveTextContent("Etsy Mockup Studio");
      expect(header).not.toHaveTextContent("Listings");
      expect(header).not.toHaveTextContent("seller@example.com");
      expect(screen.queryByRole("link", { name: "Listings" })).not.toBeInTheDocument();
    });

    it("renders no Etsy connection controls — no Connected indicator, no Disconnect", () => {
      renderBar(pathname);
      const header = screen.getByRole("banner");
      expect(header).not.toHaveTextContent(/connected/i);
      expect(header).not.toHaveTextContent(/disconnect/i);
      expect(header.querySelector("form")).toBeNull();
      expect(header.querySelector('[action*="/api/auth/etsy"]')).toBeNull();
    });

    it("always shows the LISTHOUSE wordmark", () => {
      renderBar(pathname);
      expect(screen.getByRole("banner")).toHaveTextContent("LISTHOUSE");
    });
  });

  describe("LISTHOUSE wordmark", () => {
    it.each(["/", "/settings", "/mockups"])(
      "on %s is a real, focusable link to /listings (the app's home) with a visible focus ring",
      (pathname) => {
        renderBar(pathname);
        const link = screen.getByRole("link", { name: "LISTHOUSE" });
        expect(link.tagName).toBe("A");
        expect(link).toHaveAttribute("href", "/listings");
        expect(link).toHaveClass("focus-visible:ring-2", "focus-visible:ring-accent");
        expect(link).not.toHaveClass("focus-visible:ring-0");

        link.focus();
        expect(link).toHaveFocus();
      },
    );

    it("on /listings itself is a button that sends the listings page back to its home view", () => {
      renderBar("/listings");
      expect(screen.queryByRole("link", { name: "LISTHOUSE" })).not.toBeInTheDocument();
      const onHome = vi.fn();
      window.addEventListener(LISTINGS_HOME_EVENT, onHome);
      fireEvent.click(screen.getByRole("button", { name: "LISTHOUSE" }));
      window.removeEventListener(LISTINGS_HOME_EVENT, onHome);
      expect(onHome).toHaveBeenCalledTimes(1);
    });

    it("sits top-left, before the account menu", () => {
      renderBar("/settings");
      const header = screen.getByRole("banner");
      const wordmark = screen.getByRole("link", { name: "LISTHOUSE" });
      const menu = screen.getByRole("button", { name: "Account menu" });
      expect(wordmark.compareDocumentPosition(menu) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(header.contains(wordmark)).toBe(true);
    });
  });

  describe("sidebar toggle", () => {
    it("is shown on the listings screen and collapses/expands the sidebar", () => {
      renderBar("/listings");
      const toggle = screen.getByRole("button", { name: "Toggle sidebar" });
      expect(toggle).toHaveAttribute("aria-controls", "app-sidebar");
      expect(toggle).toHaveAttribute("aria-expanded", "true");
      expect(screen.getByTestId("sidebar")).toBeVisible();

      fireEvent.click(toggle);
      expect(toggle).toHaveAttribute("aria-expanded", "false");
      expect(screen.getByTestId("sidebar")).not.toBeVisible();

      fireEvent.click(toggle);
      expect(screen.getByTestId("sidebar")).toBeVisible();
    });

    it("is not shown on pages without a sidebar", () => {
      renderBar("/settings");
      expect(screen.queryByRole("button", { name: "Toggle sidebar" })).not.toBeInTheDocument();
    });
  });

  describe("account menu", () => {
    it("the header carries only the sidebar toggle, the wordmark, and the account menu", () => {
      const { unmount } = renderBar("/listings");
      expect(screen.getAllByRole("button").map((b) => b.getAttribute("aria-label") ?? b.textContent)).toEqual([
        "Toggle sidebar",
        "LISTHOUSE",
        "Account menu",
      ]);
      expect(screen.queryAllByRole("link")).toHaveLength(0); // on /listings the wordmark is a button
      expect(screen.getByRole("banner")).toHaveTextContent("LISTHOUSE");
      unmount();

      renderBar("/settings");
      expect(screen.getAllByRole("button").map((b) => b.getAttribute("aria-label"))).toEqual(["Account menu"]);
      expect(screen.getAllByRole("link").map((l) => l.textContent)).toEqual(["LISTHOUSE"]);
    });

    it("links to /settings and signs out in one click when signed in", () => {
      renderBar("/listings");
      fireEvent.click(screen.getByRole("button", { name: "Account menu" }));

      expect(screen.getByRole("link", { name: "Account settings" })).toHaveAttribute("href", "/settings");
      expect(screen.queryByRole("link", { name: "Sign in" })).not.toBeInTheDocument();

      fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
      expect(signOutMock).toHaveBeenCalledWith({ redirect: true, callbackUrl: "/login" });
    });

    it("offers Sign in when signed out", () => {
      renderBar("/", null);
      fireEvent.click(screen.getByRole("button", { name: "Account menu" }));

      expect(screen.getByRole("link", { name: "Sign in" })).toHaveAttribute("href", "/login");
      expect(screen.queryByRole("button", { name: "Sign out" })).not.toBeInTheDocument();
    });

    it("closes on Escape", () => {
      renderBar("/");
      fireEvent.click(screen.getByRole("button", { name: "Account menu" }));
      expect(screen.getByRole("link", { name: "Account settings" })).toBeInTheDocument();

      fireEvent.keyDown(document, { key: "Escape" });
      expect(screen.queryByRole("link", { name: "Account settings" })).not.toBeInTheDocument();
    });
  });
});
