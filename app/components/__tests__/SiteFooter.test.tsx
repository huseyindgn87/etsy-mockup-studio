// @vitest-environment jsdom
import { render, screen, within } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";

vi.mock("@/app/components/Turnstile", () => ({ default: () => null }));
vi.mock("@/lib/auth/turnstile", () => ({ turnstileSiteKey: () => "test-key" }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("next-auth/react", () => ({ signIn: vi.fn() }));
vi.mock("@/lib/account/current-user", () => ({
  getCurrentUser: async () => ({ email: "seller@example.com", firstName: null }),
}));
vi.mock("@/app/(app)/NavBar", () => ({ default: () => null }));

import SiteFooter from "../SiteFooter";
import LoginPage from "@/app/login/page";
import LegalLayout from "@/app/(legal)/layout";
import AppLayout from "@/app/(app)/layout";
import { ETSY_TRADEMARK_NOTICE } from "@/lib/legal";

const EXPECTED = [
  ["Terms of Service", "/terms"],
  ["Privacy Policy", "/privacy"],
  ["Refund Policy", "/refunds"],
  ["Cookie Policy", "/cookies"],
] as const;

function expectLegalLinks() {
  const nav = screen.getByRole("navigation", { name: "Legal" });
  for (const [label, href] of EXPECTED) {
    expect(within(nav).getByRole("link", { name: label })).toHaveAttribute("href", href);
  }
}

describe("SiteFooter", () => {
  test("links all four legal pages and carries Etsy's trademark notice", () => {
    render(<SiteFooter />);
    expectLegalLinks();
    expect(screen.getByText(ETSY_TRADEMARK_NOTICE)).toBeInTheDocument();
  });

  test("keeps extra links passed to it", () => {
    render(
      <SiteFooter>
        <a href="/admin/templates">Templates</a>
      </SiteFooter>,
    );
    expect(screen.getByRole("link", { name: "Templates" })).toHaveAttribute("href", "/admin/templates");
    expectLegalLinks();
  });

  test("the Etsy notice has Etsy's required wording", () => {
    expect(ETSY_TRADEMARK_NOTICE).toBe(
      "The term 'Etsy' is a trademark of Etsy, Inc. This application uses the Etsy API but is not endorsed or certified by Etsy, Inc.",
    );
  });

  test("appears on the sign-in page", () => {
    render(<LoginPage />);
    expectLegalLinks();
  });

  test("appears in the signed-in app, beside the Templates link", async () => {
    render(await AppLayout({ children: "content" }));
    expectLegalLinks();
    expect(screen.getByRole("link", { name: "Templates" })).toBeInTheDocument();
  });

  test("appears on every legal page", () => {
    render(<LegalLayout>content</LegalLayout>);
    expectLegalLinks();
  });
});
