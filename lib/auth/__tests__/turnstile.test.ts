import { afterEach, describe, expect, test, vi } from "vitest";
import { TURNSTILE_TEST_SECRET_KEY, TURNSTILE_TEST_SITE_KEY, turnstileSiteKey, verifyTurnstile } from "../turnstile";

afterEach(() => {
  vi.unstubAllEnvs();
});

function fakeFetch(success: boolean) {
  return vi.fn(async (...args: [string, RequestInit]) => (void args, Response.json({ success })));
}

describe("Turnstile", () => {
  test("uses Cloudflare's test keys outside production when none are set", async () => {
    vi.stubEnv("TURNSTILE_SITE_KEY", "");
    vi.stubEnv("TURNSTILE_SECRET_KEY", "");
    expect(turnstileSiteKey()).toBe(TURNSTILE_TEST_SITE_KEY);
    const fetchImpl = fakeFetch(true);
    expect(await verifyTurnstile("tok", "203.0.113.7", fetchImpl as unknown as typeof fetch)).toBe(true);
    const body = fetchImpl.mock.calls[0][1]!.body as URLSearchParams;
    expect(body.get("secret")).toBe(TURNSTILE_TEST_SECRET_KEY);
    expect(body.get("response")).toBe("tok");
    expect(body.get("remoteip")).toBe("203.0.113.7");
  });

  test("reads the real keys from TURNSTILE_SITE_KEY / TURNSTILE_SECRET_KEY", async () => {
    vi.stubEnv("TURNSTILE_SITE_KEY", "site-real");
    vi.stubEnv("TURNSTILE_SECRET_KEY", "secret-real");
    expect(turnstileSiteKey()).toBe("site-real");
    const fetchImpl = fakeFetch(true);
    await verifyTurnstile("tok", undefined, fetchImpl as unknown as typeof fetch);
    expect((fetchImpl.mock.calls[0][1]!.body as URLSearchParams).get("secret")).toBe("secret-real");
  });

  test("a check Cloudflare rejects, an empty token or a network error fails", async () => {
    expect(await verifyTurnstile("tok", undefined, fakeFetch(false) as unknown as typeof fetch)).toBe(false);
    expect(await verifyTurnstile("", undefined, fakeFetch(true) as unknown as typeof fetch)).toBe(false);
    const broken = vi.fn(async () => {
      throw new Error("offline");
    });
    expect(await verifyTurnstile("tok", undefined, broken as unknown as typeof fetch)).toBe(false);
  });

  test("in production without keys nothing passes", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("TURNSTILE_SITE_KEY", "");
    vi.stubEnv("TURNSTILE_SECRET_KEY", "");
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(turnstileSiteKey()).toBeNull();
    expect(await verifyTurnstile("tok", undefined, fakeFetch(true) as unknown as typeof fetch)).toBe(false);
  });
});
