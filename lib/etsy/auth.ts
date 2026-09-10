import { cookies } from "next/headers";
import { getEtsyConfig, ETSY_ENDPOINTS } from "./config";
import { refreshSession } from "./oauth";
import {
  openSession,
  sealSession,
  SESSION_COOKIE,
  SESSION_MAX_AGE_SECONDS,
  type EtsySession,
} from "./session";

/**
 * Read the current Etsy session from the encrypted cookie.
 *
 * Safe to call from Server Components. The returned token may be expired —
 * cookies cannot be rewritten during render, so refresh happens in Route
 * Handlers / Server Actions via {@link getAccessToken}.
 */
export async function getEtsySession(): Promise<EtsySession | null> {
  const { sessionSecret } = getEtsyConfig();
  const store = await cookies();
  return openSession(store.get(SESSION_COOKIE)?.value, sessionSecret);
}

export async function isConnected(): Promise<boolean> {
  return (await getEtsySession()) !== null;
}

export function sessionCookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    maxAge: SESSION_MAX_AGE_SECONDS,
  };
}

/**
 * Return a valid access token, refreshing and persisting a new session cookie
 * if the current one is expired. Only usable where cookies are writable
 * (Route Handlers, Server Actions). Returns null when not connected.
 */
export async function getAccessToken(): Promise<string | null> {
  const { sessionSecret } = getEtsyConfig();
  const store = await cookies();
  const current = openSession(store.get(SESSION_COOKIE)?.value, sessionSecret);
  if (!current) return null;

  if (Date.now() < current.expiresAt) return current.accessToken;

  const refreshed = await refreshSession(current.refreshToken);
  store.set(
    SESSION_COOKIE,
    sealSession(refreshed, sessionSecret),
    sessionCookieOptions(),
  );
  return refreshed.accessToken;
}

/**
 * Call the Etsy API v3 with the stored token. Adds the required `Authorization`
 * and `x-api-key` headers. Throws if not connected.
 */
export async function etsyFetch(
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const accessToken = await getAccessToken();
  if (!accessToken) throw new Error("Not connected to Etsy.");
  const { clientId, sharedSecret } = getEtsyConfig();

  const url = path.startsWith("http")
    ? path
    : `${ETSY_ENDPOINTS.apiBase}${path.startsWith("/") ? path : `/${path}`}`;

  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${accessToken}`);
  // This app's key is rejected as a bare keystring ("Shared secret is required
  // in x-api-key header"); Etsy wants `keystring:shared_secret` here.
  headers.set(
    "x-api-key",
    sharedSecret ? `${clientId}:${sharedSecret}` : clientId,
  );

  return fetch(url, { ...init, headers, cache: "no-store" });
}
