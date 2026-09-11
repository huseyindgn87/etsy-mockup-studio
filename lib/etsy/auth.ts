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

/** Retries on 429 before giving up and returning the (still 429) response to the caller. */
export const MAX_RATE_LIMIT_RETRIES = 3;

/** Etsy's own quota headers (present on every response) — logged so we can see how close we are before it happens again. */
const RATE_LIMIT_HEADERS = [
  "x-limit-per-second",
  "x-remaining-this-second",
  "x-limit-per-day",
  "x-remaining-today",
] as const;

function logRateLimitHeaders(url: string, res: Response): void {
  const parts: string[] = [];
  for (const name of RATE_LIMIT_HEADERS) {
    const value = res.headers.get(name);
    if (value != null) parts.push(`${name}=${value}`);
  }
  if (parts.length) console.log(`[etsy] quota ${url} ${parts.join(" ")}`);
}

/** Delay before the next retry: Etsy's own `Retry-After` when it sends one, else exponential backoff with jitter. */
export function rateLimitDelayMs(res: Response, attempt: number): number {
  const retryAfter = res.headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
    const at = Date.parse(retryAfter);
    if (!Number.isNaN(at)) return Math.max(0, at - Date.now());
  }
  return 500 * 2 ** attempt + Math.floor(Math.random() * 250);
}

/**
 * `fetch`, retrying up to {@link MAX_RATE_LIMIT_RETRIES} times on a 429
 * response (honoring `Retry-After` when Etsy sends one) and logging the
 * remaining-quota headers on every attempt. Exported standalone so the
 * retry/backoff logic is unit-testable without the cookie/session plumbing
 * `etsyFetch` needs.
 */
export async function fetchWithRateLimitRetry(
  url: string,
  init: RequestInit,
  wait: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, init);
    logRateLimitHeaders(url, res);
    if (res.status !== 429 || attempt >= MAX_RATE_LIMIT_RETRIES) return res;
    const delay = rateLimitDelayMs(res, attempt);
    console.warn(
      `[etsy] 429 from ${url} — retrying in ${Math.round(delay)}ms (attempt ${attempt + 1}/${MAX_RATE_LIMIT_RETRIES})`,
    );
    await wait(delay);
  }
}

/**
 * Call the Etsy API v3 with the stored token. Adds the required `Authorization`
 * and `x-api-key` headers, retries on rate-limiting, and throws if not connected.
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

  return fetchWithRateLimitRetry(url, { ...init, headers, cache: "no-store" });
}
