import { cookies } from "next/headers";
import { currentEtsyContext, etsyRequest, withEtsyContext, type EtsyCallContext } from "./client";
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
 * Read the current Etsy session from the encrypted cookie — but only if it
 * was connected by the app account that's signed in right now. A cookie
 * whose `ownerUserId` doesn't match (a stale connection from a different app
 * account on a shared browser, most commonly) is treated as "not connected"
 * rather than handed back, so one app user can never ride another's Etsy
 * connection.
 *
 * Safe to call from Server Components. The returned token may be expired —
 * cookies cannot be rewritten during render, so refresh happens in Route
 * Handlers / Server Actions via {@link getAccessToken}.
 *
 * `@/auth` is imported dynamically, not at module scope — it constructs a
 * Prisma client at import time, and this module is imported by plenty of
 * code (and tests) that never call `getEtsySession` and shouldn't have to
 * satisfy that dependency just to load.
 */
export async function getEtsySession(): Promise<EtsySession | null> {
  const { sessionSecret } = getEtsyConfig();
  const store = await cookies();
  const session = openSession(store.get(SESSION_COOKIE)?.value, sessionSecret);
  if (!session) return null;

  const { auth } = await import("@/auth");
  const appSession = await auth();
  if (!appSession?.user?.id || appSession.user.id !== session.ownerUserId) return null;
  return session;
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
  return (await getSessionAccessToken())?.accessToken ?? null;
}

async function getSessionAccessToken(): Promise<{ accessToken: string; ownerUserId: string } | null> {
  const current = await getEtsySession();
  if (!current) return null;

  if (Date.now() < current.expiresAt) return { accessToken: current.accessToken, ownerUserId: current.ownerUserId };

  const { sessionSecret } = getEtsyConfig();
  const store = await cookies();
  const refreshed = await refreshSession(current.refreshToken);
  const session: EtsySession = { ...refreshed, ownerUserId: current.ownerUserId };
  store.set(SESSION_COOKIE, sealSession(session, sessionSecret), sessionCookieOptions());
  return { accessToken: session.accessToken, ownerUserId: current.ownerUserId };
}

/** Runs `fn` with every `etsyFetch` inside it authenticated by `accessToken` instead of the session cookie. */
export function withEtsyAccessToken<T>(
  accessToken: string,
  fn: () => Promise<T>,
  context: Omit<EtsyCallContext, "accessToken"> = {},
): Promise<T> {
  return withEtsyContext({ ...context, accessToken }, fn);
}

/**
 * Call the Etsy API v3 with the stored token (or the one pinned by
 * {@link withEtsyAccessToken}), through the shared rate-limited client
 * (lib/etsy/client.ts). Adds the required `Authorization` and `x-api-key`
 * headers, and throws if not connected.
 */
export async function etsyFetch(
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const context = currentEtsyContext();
  let accessToken = context.accessToken ?? null;
  let userId = context.userId ?? null;
  if (!accessToken) {
    const session = await getSessionAccessToken();
    accessToken = session?.accessToken ?? null;
    userId ??= session?.ownerUserId ?? null;
  }
  if (!accessToken) throw new Error("Not connected to Etsy.");

  const url = path.startsWith("http")
    ? path
    : `${ETSY_ENDPOINTS.apiBase}${path.startsWith("/") ? path : `/${path}`}`;

  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${accessToken}`);
  headers.set("x-api-key", etsyApiKeyHeader());

  return etsyRequest(url, { ...init, headers }, { userId });
}

/**
 * This app's key is rejected as a bare keystring ("Shared secret is required
 * in x-api-key header"); Etsy wants `keystring:shared_secret` here.
 */
export function etsyApiKeyHeader(): string {
  const { clientId, sharedSecret } = getEtsyConfig();
  return sharedSecret ? `${clientId}:${sharedSecret}` : clientId;
}
