import { describe, expect, test } from "vitest";
import { decideRouteAccess } from "../route-guard";

describe("decideRouteAccess", () => {
  test("redirects an anonymous page request to /login with a callbackUrl", () => {
    const decision = decideRouteAccess("/listings", false);
    expect(decision).toEqual({ action: "redirect", path: "/login?callbackUrl=%2Flistings" });
  });

  test("redirects an anonymous request to the home page too", () => {
    const decision = decideRouteAccess("/", false);
    expect(decision).toEqual({ action: "redirect", path: "/login?callbackUrl=%2F" });
  });

  test("returns 401 JSON for an anonymous API request instead of redirecting", () => {
    const decision = decideRouteAccess("/api/drafts", false);
    expect(decision).toEqual({ action: "unauthorized" });
  });

  test("lets a signed-in request through to any app page", () => {
    expect(decideRouteAccess("/listings", true)).toEqual({ action: "next" });
    expect(decideRouteAccess("/", true)).toEqual({ action: "next" });
  });

  test("/login and /register are public for an anonymous visitor", () => {
    expect(decideRouteAccess("/login", false)).toEqual({ action: "next" });
    expect(decideRouteAccess("/register", false)).toEqual({ action: "next" });
  });

  test("the legal pages are public, signed in or not", () => {
    for (const path of ["/terms", "/privacy", "/refunds", "/cookies"]) {
      expect(decideRouteAccess(path, false)).toEqual({ action: "next" });
      expect(decideRouteAccess(path, true)).toEqual({ action: "next" });
    }
  });

  test("a signed-in visitor is bounced away from /login and /register", () => {
    expect(decideRouteAccess("/login", true)).toEqual({ action: "redirect", path: "/" });
    expect(decideRouteAccess("/register", true)).toEqual({ action: "redirect", path: "/" });
  });

  test("Auth.js's own /api/auth/* endpoints stay public", () => {
    expect(decideRouteAccess("/api/auth/session", false)).toEqual({ action: "next" });
    expect(decideRouteAccess("/api/auth/callback/credentials", false)).toEqual({ action: "next" });
  });

  test("/api/auth/etsy/* is NOT covered by the Auth.js bypass — still requires a signed-in app user", () => {
    expect(decideRouteAccess("/api/auth/etsy/login", false)).toEqual({ action: "unauthorized" });
    expect(decideRouteAccess("/api/auth/etsy/callback", false)).toEqual({ action: "unauthorized" });
    expect(decideRouteAccess("/api/auth/etsy/login", true)).toEqual({ action: "next" });
  });

  test("the drafts sweep cron endpoint is public (guarded by its own bearer secret)", () => {
    expect(decideRouteAccess("/api/drafts/sweep", false)).toEqual({ action: "next" });
  });
});
