import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { fetchWithRateLimitRetry, MAX_RATE_LIMIT_RETRIES, rateLimitDelayMs } from "@/lib/etsy/auth";

const res = (status: number, headers: Record<string, string> = {}): Response =>
  ({
    status,
    ok: status >= 200 && status < 300,
    headers: new Headers(headers),
  }) as Response;

describe("rateLimitDelayMs", () => {
  test("uses Retry-After (seconds) when Etsy sends one", () => {
    expect(rateLimitDelayMs(res(429, { "retry-after": "2" }), 0)).toBe(2000);
  });

  test("uses Retry-After as an HTTP-date when it isn't a plain number", () => {
    const future = new Date(Date.now() + 3000).toUTCString();
    const delay = rateLimitDelayMs(res(429, { "retry-after": future }), 0);
    expect(delay).toBeGreaterThan(2000);
    expect(delay).toBeLessThanOrEqual(3000);
  });

  test("falls back to exponential backoff when Etsy sends no Retry-After", () => {
    const d0 = rateLimitDelayMs(res(429), 0);
    const d1 = rateLimitDelayMs(res(429), 1);
    const d2 = rateLimitDelayMs(res(429), 2);
    expect(d0).toBeGreaterThanOrEqual(500);
    expect(d0).toBeLessThan(1000);
    expect(d1).toBeGreaterThanOrEqual(1000);
    expect(d1).toBeLessThan(1500);
    expect(d2).toBeGreaterThanOrEqual(2000);
    expect(d2).toBeLessThan(2500);
  });
});

describe("fetchWithRateLimitRetry", () => {
  const waits: number[] = [];
  const wait = async (ms: number) => {
    waits.push(ms);
  };

  beforeEach(() => {
    waits.length = 0;
    vi.stubGlobal("fetch", vi.fn());
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  test("returns immediately on a non-429 response, without waiting", async () => {
    vi.mocked(fetch).mockResolvedValue(res(200));
    const out = await fetchWithRateLimitRetry("https://x/test", {}, wait);
    expect(out.status).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(waits).toEqual([]);
  });

  test("retries on 429 up to the max, then returns the still-429 response", async () => {
    vi.mocked(fetch).mockResolvedValue(res(429, { "retry-after": "1" }));
    const out = await fetchWithRateLimitRetry("https://x/test", {}, wait);
    expect(out.status).toBe(429);
    expect(fetch).toHaveBeenCalledTimes(MAX_RATE_LIMIT_RETRIES + 1);
    expect(waits).toHaveLength(MAX_RATE_LIMIT_RETRIES);
    expect(waits.every((w) => w === 1000)).toBe(true);
  });

  test("stops retrying as soon as a request succeeds", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(res(429, { "retry-after": "0" }))
      .mockResolvedValueOnce(res(200));
    const out = await fetchWithRateLimitRetry("https://x/test", {}, wait);
    expect(out.status).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(waits).toHaveLength(1);
  });

  test("logs the quota headers on every attempt", async () => {
    vi.mocked(fetch).mockResolvedValue(
      res(200, {
        "x-limit-per-second": "10",
        "x-remaining-this-second": "9",
        "x-limit-per-day": "10000",
        "x-remaining-today": "9999",
      }),
    );
    await fetchWithRateLimitRetry("https://x/test", {}, wait);
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining("x-remaining-today=9999"),
    );
  });
});
