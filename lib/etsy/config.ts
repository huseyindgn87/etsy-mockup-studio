/**
 * Etsy OAuth 2.0 (API v3) configuration.
 *
 * Etsy uses the Authorization Code grant with PKCE and does NOT require a
 * client secret. The "client id" is the app's keystring from
 * https://www.etsy.com/developers/your-apps
 *
 * Env is validated lazily (on first request that needs it) so `next build`
 * works without credentials.
 */

export const ETSY_ENDPOINTS = {
  authorize: "https://www.etsy.com/oauth/connect",
  token: "https://api.etsy.com/v3/public/oauth/token",
  apiBase: "https://api.etsy.com/v3/application",
} as const;

/** Default scopes for a mockup / listing workflow. Override with ETSY_SCOPES. */
const DEFAULT_SCOPES = "listings_r listings_w shops_r";

const DEFAULT_REDIRECT_URI = "http://localhost:3000/api/auth/etsy/callback";

export interface EtsyConfig {
  clientId: string;
  redirectUri: string;
  /** Space-separated scope string, exactly as Etsy expects it. */
  scope: string;
  /** Secret used to encrypt the session cookie (AES-256-GCM). */
  sessionSecret: string;
}

let cached: EtsyConfig | null = null;

export function getEtsyConfig(): EtsyConfig {
  if (cached) return cached;

  const clientId = process.env.ETSY_CLIENT_ID;
  const sessionSecret =
    process.env.ETSY_OAUTH_SESSION_SECRET ?? process.env.SESSION_SECRET;

  const missing: string[] = [];
  if (!clientId) missing.push("ETSY_CLIENT_ID");
  if (!sessionSecret) missing.push("ETSY_OAUTH_SESSION_SECRET");
  if (missing.length > 0) {
    throw new Error(
      `Missing required Etsy OAuth env var(s): ${missing.join(
        ", ",
      )}. Copy .env.example to .env.local and fill them in.`,
    );
  }
  if (sessionSecret!.length < 32) {
    throw new Error(
      "ETSY_OAUTH_SESSION_SECRET must be at least 32 characters. Generate one with: openssl rand -base64 32",
    );
  }

  cached = {
    clientId: clientId!,
    redirectUri: process.env.ETSY_REDIRECT_URI ?? DEFAULT_REDIRECT_URI,
    scope: process.env.ETSY_SCOPES ?? DEFAULT_SCOPES,
    sessionSecret: sessionSecret!,
  };
  return cached;
}
