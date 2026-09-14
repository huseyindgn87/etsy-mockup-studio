import { describe, expect, test } from "vitest";
import { encode } from "next-auth/jwt";
import { applyRememberMeCookiePolicy, REMEMBER_ME_MAX_AGE_SECONDS } from "../session-cookie";

const TEST_SECRET = "test-secret-at-least-32-characters-long";
process.env.AUTH_SECRET = TEST_SECRET;

const COOKIE_NAME = "authjs.session-token";
const SECURE_COOKIE_NAME = "__Secure-authjs.session-token";

async function signedToken(rememberMe: boolean, cookieName = COOKIE_NAME): Promise<string> {
  return encode({
    token: { sub: "u1", rememberMe },
    secret: TEST_SECRET,
    salt: cookieName,
  });
}

/** Mirrors the real attribute order @auth/core's vendored cookie serializer produces. */
function setCookieHeader(
  cookieName: string,
  value: string,
  { expires, secure = false }: { expires?: Date; secure?: boolean } = {},
): string {
  let str = `${cookieName}=${value}; Path=/`;
  if (expires) str += `; Expires=${expires.toUTCString()}`;
  str += "; HttpOnly";
  if (secure) str += "; Secure";
  str += "; SameSite=Lax";
  return str;
}

function responseWithSetCookie(...setCookies: string[]): Response {
  const headers = new Headers();
  for (const c of setCookies) headers.append("set-cookie", c);
  return new Response(null, { status: 200, headers });
}

const THIRTY_DAYS_FROM_NOW = new Date(Date.now() + REMEMBER_ME_MAX_AGE_SECONDS * 1000);

describe("applyRememberMeCookiePolicy", () => {
  test("unchecked sign-in: strips Expires/Max-Age, leaving a true browser-session cookie", async () => {
    const token = await signedToken(false);
    const res = responseWithSetCookie(
      setCookieHeader(COOKIE_NAME, token, { expires: THIRTY_DAYS_FROM_NOW }),
    );

    const out = await applyRememberMeCookiePolicy(res);
    const cookie = out.headers.getSetCookie()[0];

    expect(cookie).not.toMatch(/Expires=/i);
    expect(cookie).not.toMatch(/Max-Age=/i);
  });

  test("checked sign-in: keeps the persistent ~30-day expiry Auth.js wrote", async () => {
    const token = await signedToken(true);
    const res = responseWithSetCookie(
      setCookieHeader(COOKIE_NAME, token, { expires: THIRTY_DAYS_FROM_NOW }),
    );

    const out = await applyRememberMeCookiePolicy(res);
    const cookie = out.headers.getSetCookie()[0];

    expect(cookie).toContain(`Expires=${THIRTY_DAYS_FROM_NOW.toUTCString()}`);
  });

  test("unchecked sign-in: httpOnly, sameSite=lax, and path are unchanged", async () => {
    const token = await signedToken(false);
    const res = responseWithSetCookie(
      setCookieHeader(COOKIE_NAME, token, { expires: THIRTY_DAYS_FROM_NOW }),
    );

    const cookie = (await applyRememberMeCookiePolicy(res)).headers.getSetCookie()[0];

    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect(cookie).toMatch(/Path=\//i);
  });

  test("unchecked sign-in over HTTPS (secure cookie, __Secure- prefix): Secure flag is preserved, expiry still stripped", async () => {
    const token = await signedToken(false, SECURE_COOKIE_NAME);
    const res = responseWithSetCookie(
      setCookieHeader(SECURE_COOKIE_NAME, token, { expires: THIRTY_DAYS_FROM_NOW, secure: true }),
    );

    const cookie = (await applyRememberMeCookiePolicy(res)).headers.getSetCookie()[0];

    expect(cookie).toMatch(/Secure/);
    expect(cookie).not.toMatch(/Expires=/i);
  });

  test("checked sign-in over HTTPS: Secure flag and expiry both preserved", async () => {
    const token = await signedToken(true, SECURE_COOKIE_NAME);
    const res = responseWithSetCookie(
      setCookieHeader(SECURE_COOKIE_NAME, token, { expires: THIRTY_DAYS_FROM_NOW, secure: true }),
    );

    const cookie = (await applyRememberMeCookiePolicy(res)).headers.getSetCookie()[0];

    expect(cookie).toMatch(/Secure/);
    expect(cookie).toContain(`Expires=${THIRTY_DAYS_FROM_NOW.toUTCString()}`);
  });

  test("leaves non-session cookies (e.g. the CSRF cookie) completely untouched", async () => {
    const token = await signedToken(false);
    const res = responseWithSetCookie(
      setCookieHeader(COOKIE_NAME, token, { expires: THIRTY_DAYS_FROM_NOW }),
      "authjs.csrf-token=abc123; Path=/; HttpOnly; SameSite=Lax",
    );

    const cookies = (await applyRememberMeCookiePolicy(res)).headers.getSetCookie();
    const csrf = cookies.find((c) => c.startsWith("authjs.csrf-token="));

    expect(csrf).toBe("authjs.csrf-token=abc123; Path=/; HttpOnly; SameSite=Lax");
  });

  test("no session cookie in the response: passes it through unchanged", async () => {
    const res = responseWithSetCookie("authjs.csrf-token=abc123; Path=/; HttpOnly; SameSite=Lax");
    const out = await applyRememberMeCookiePolicy(res);
    expect(out).toBe(res);
  });

  test("no AUTH_SECRET available: leaves Auth.js's default cookie alone rather than guessing", async () => {
    const token = await signedToken(false);
    const res = responseWithSetCookie(
      setCookieHeader(COOKIE_NAME, token, { expires: THIRTY_DAYS_FROM_NOW }),
    );

    const original = process.env.AUTH_SECRET;
    delete process.env.AUTH_SECRET;
    try {
      const out = await applyRememberMeCookiePolicy(res);
      expect(out).toBe(res);
    } finally {
      process.env.AUTH_SECRET = original;
    }
  });

  test("an undecodable session cookie is left alone rather than crashing the response", async () => {
    const res = responseWithSetCookie(
      setCookieHeader(COOKIE_NAME, "not-a-real-jwt", { expires: THIRTY_DAYS_FROM_NOW }),
    );
    const out = await applyRememberMeCookiePolicy(res);
    expect(out.headers.getSetCookie()[0]).toContain("Expires=");
  });
});
