import { decode } from "next-auth/jwt";

/** "Keep me signed in" persistent-cookie lifetime. Also auth.ts's `session.maxAge`. */
export const REMEMBER_ME_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

const SESSION_COOKIE_RE = /^(__Secure-)?authjs\.session-token(\.\d+)?=/;

function cookieName(setCookieStr: string): string {
  return setCookieStr.slice(0, setCookieStr.indexOf("="));
}

function cookieValue(setCookieStr: string): string {
  const rest = setCookieStr.slice(setCookieStr.indexOf("=") + 1);
  const end = rest.indexOf(";");
  return decodeURIComponent(end === -1 ? rest : rest.slice(0, end));
}

/** Drops only the `Max-Age`/`Expires` attributes; every other attribute (httpOnly, secure, sameSite, path) is left exactly as Auth.js wrote it. */
function stripPersistence(setCookieStr: string): string {
  return setCookieStr
    .split(/;\s*/)
    .filter((part) => !/^(max-age|expires)=/i.test(part.trim()))
    .join("; ");
}

/**
 * Auth.js always writes the session cookie with a fixed `Max-Age`/`Expires`
 * (from the static `session.maxAge` config) — there's no built-in per-sign-in
 * hook for this; traced through `@auth/core`'s callback/session action code,
 * the cookie's expiry is computed before the `session` callback ever runs; and
 * "the `session` callback controls cookie maxAge" advice found in the wild
 * doesn't hold for the JWT strategy — it only affects the JSON body a client
 * fetch of `/api/auth/session` sees, never the `Set-Cookie` header itself.
 *
 * So instead: let every sign-in and sliding-renewal write Auth.js's normal
 * 30-day cookie (auth.ts's `session.maxAge`), then re-check what it just
 * wrote here. The cookie's own JWT carries `rememberMe` (set at sign-in by
 * auth.ts's `jwt` callback, persisting across renewals since the token is
 * threaded through unchanged). When it's `false`, strip `Max-Age`/`Expires`
 * so the browser treats the cookie as a session cookie — gone the moment the
 * browser closes, no matter how many times it's silently renewed before then.
 */
export async function applyRememberMeCookiePolicy(response: Response): Promise<Response> {
  const setCookies = response.headers.getSetCookie();
  const sessionCookie = setCookies.find((c) => SESSION_COOKIE_RE.test(c));
  if (!sessionCookie) return response;

  const secret = process.env.AUTH_SECRET;
  if (!secret) return response; // can't verify — leave Auth.js's default cookie alone

  let rememberMe = true;
  try {
    const salt = cookieName(sessionCookie).replace(/\.\d+$/, "");
    const payload = await decode({ token: cookieValue(sessionCookie), secret, salt });
    rememberMe = !!payload?.rememberMe;
  } catch {
    return response;
  }

  if (rememberMe) return response;

  const headers = new Headers();
  response.headers.forEach((value, key) => {
    if (key.toLowerCase() !== "set-cookie") headers.append(key, value);
  });
  for (const c of setCookies) {
    headers.append("set-cookie", SESSION_COOKIE_RE.test(c) ? stripPersistence(c) : c);
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
