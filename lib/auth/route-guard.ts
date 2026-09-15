/**
 * The route-protection decision proxy.ts acts on, pulled out as a pure
 * function so it's unit-testable without going through NextAuth's request
 * plumbing (and Next's Proxy convention — see proxy.ts's own comment).
 */

const PUBLIC_EXACT = new Set([
  "/login",
  "/register",
  // An external cron endpoint guarded by its own bearer secret, not a
  // browser session — see app/api/drafts/sweep/route.ts.
  "/api/drafts/sweep",
  // The scheduled-listing runner, triggered by a cron service or
  // `npm run schedule:run` — requires its own shared secret, see
  // app/api/schedule/run/route.ts.
  "/api/schedule/run",
]);

const AUTH_PAGES = new Set(["/login", "/register"]);

/**
 * Auth.js's own `/api/auth/*` endpoints (session/csrf/signin/signout/
 * callback/providers/error) — signing in necessarily happens while
 * unauthenticated, so these must stay reachable. `/api/auth/etsy/*` is
 * deliberately excluded from this bypass: connecting an Etsy shop is an app
 * action and must still require a signed-in app user.
 */
function isNextAuthInternal(pathname: string): boolean {
  return pathname.startsWith("/api/auth/") && !pathname.startsWith("/api/auth/etsy/");
}

export type RouteDecision =
  | { action: "next" }
  | { action: "redirect"; path: string }
  | { action: "unauthorized" };

export function decideRouteAccess(pathname: string, signedIn: boolean): RouteDecision {
  if (PUBLIC_EXACT.has(pathname) || isNextAuthInternal(pathname)) {
    if (signedIn && AUTH_PAGES.has(pathname)) return { action: "redirect", path: "/" };
    return { action: "next" };
  }

  if (!signedIn) {
    if (pathname.startsWith("/api/")) return { action: "unauthorized" };
    return {
      action: "redirect",
      path: `/login?callbackUrl=${encodeURIComponent(pathname)}`,
    };
  }

  return { action: "next" };
}
