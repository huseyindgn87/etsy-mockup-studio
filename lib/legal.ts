export const LEGAL_PAGES = [
  { href: "/terms", label: "Terms of Service" },
  { href: "/privacy", label: "Privacy Policy" },
  { href: "/refunds", label: "Refund Policy" },
  { href: "/cookies", label: "Cookie Policy" },
] as const;

export const LEGAL_PATHS: readonly string[] = LEGAL_PAGES.map((p) => p.href);

export const LEGAL_LAST_UPDATED = "18 September 2026";

/** Wording required by Etsy's API Terms of Use. */
export const ETSY_TRADEMARK_NOTICE =
  "The term 'Etsy' is a trademark of Etsy, Inc. This application uses the Etsy API but is not endorsed or certified by Etsy, Inc.";

/** Every cookie the app sets. All are strictly necessary, so there is no consent banner. */
export const COOKIES = [
  {
    name: "authjs.session-token",
    purpose: "Keeps you signed in (an encrypted session token).",
    duration: "30 days with “Keep me signed in”, otherwise until you close the browser",
  },
  {
    name: "authjs.csrf-token",
    purpose: "Protects the sign-in form against cross-site request forgery.",
    duration: "Until you close the browser",
  },
  {
    name: "authjs.callback-url",
    purpose: "Remembers which page to return to after signing in.",
    duration: "Until you close the browser",
  },
  {
    name: "etsy_session",
    purpose: "Your Etsy connection: encrypted Etsy access and refresh tokens, tied to your account.",
    duration: "90 days, or until you disconnect the shop",
  },
  {
    name: "etsy_oauth_state, etsy_pkce_verifier",
    purpose: "Secure the Etsy connection step; removed as soon as it completes.",
    duration: "10 minutes",
  },
] as const;
