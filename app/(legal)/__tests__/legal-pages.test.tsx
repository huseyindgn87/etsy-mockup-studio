// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import TermsPage from "../terms/page";
import PrivacyPage from "../privacy/page";
import RefundsPage from "../refunds/page";
import CookiesPage from "../cookies/page";
import { ETSY_TRADEMARK_NOTICE, LEGAL_PAGES } from "@/lib/legal";

const PAGES = [
  ["/terms", TermsPage, "Terms of Service"],
  ["/privacy", PrivacyPage, "Privacy Policy"],
  ["/refunds", RefundsPage, "Refund Policy"],
  ["/cookies", CookiesPage, "Cookie Policy"],
] as const;

describe("legal pages", () => {
  test("the four routes are the ones the footer links", () => {
    expect(LEGAL_PAGES.map((p) => [p.href, p.label])).toEqual(PAGES.map(([href, , title]) => [href, title]));
  });

  test.each(PAGES)("%s renders its heading and a last-updated date", (_href, Page, title) => {
    render(<Page />);
    expect(screen.getByRole("heading", { level: 1, name: title })).toBeInTheDocument();
    expect(screen.getByText(/Last updated:/)).toBeInTheDocument();
  });

  test.each(PAGES)("%s marks every business detail as a [FILL: …] placeholder", (_href, Page) => {
    const { container } = render(<Page />);
    const marks = [...container.querySelectorAll("mark")].map((m) => m.textContent);
    expect(marks.length).toBeGreaterThan(0);
    for (const m of marks) expect(m).toMatch(/^\[FILL: .+\]$/);
    expect(container.textContent).toContain("[FILL: contact email]");
  });

  test("Terms and Privacy carry Etsy's trademark notice", () => {
    for (const Page of [TermsPage, PrivacyPage]) {
      const { container, unmount } = render(<Page />);
      expect(container.textContent).toContain(ETSY_TRADEMARK_NOTICE);
      unmount();
    }
  });

  test("Privacy names every service data is sent to, and none that isn't used", () => {
    const { container } = render(<PrivacyPage />);
    const text = container.textContent!;
    for (const name of ["Etsy", "Cloudflare (R2 storage)", "Cloudflare (Turnstile)", "Neon", "Anthropic", "bcrypt", "AES-256-GCM"]) {
      expect(text).toContain(name);
    }
    for (const absent of ["Google Analytics", "Stripe", "Sentry", "Facebook"]) {
      expect(text).not.toContain(absent);
    }
  });

  test("Cookies lists only essential cookies and says there's no consent banner", () => {
    const { container } = render(<CookiesPage />);
    const text = container.textContent!;
    for (const name of ["authjs.session-token", "authjs.csrf-token", "etsy_session", "etsy_oauth_state, etsy_pkce_verifier"]) {
      expect(screen.getByText(name)).toBeInTheDocument();
    }
    expect(text).toMatch(/don.t show a cookie consent banner/);
  });
});
