import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  assertEtsyBudget,
  configureEtsyClient,
  createMemoryRateLimitStore,
  DAILY_RECHECK_MS,
  DEFAULT_PER_SECOND,
  EtsyApiError,
  EtsyLimitError,
  etsyBudgetError,
  etsyRequest,
  MAX_RATE_LIMIT_RETRIES,
  MAX_SERVER_RETRIES,
  parseRateLimitHeaders,
  retryDelayMs,
  withEtsyContext,
} from "@/lib/etsy/client";

const URL_ = "https://api.etsy.com/v3/application/shops/1/listings?limit=100";
const T0 = Date.UTC(2026, 8, 18, 12, 0, 0);

const res = (status: number, headers: Record<string, string> = {}): Response =>
  ({ status, ok: status >= 200 && status < 300, headers: new Headers(headers) }) as Response;

let now = T0;
const sleeps: number[] = [];
let store: ReturnType<typeof createMemoryRateLimitStore>;
const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();
const warn = vi.fn();
const error = vi.fn();

function setup(initial: Parameters<typeof createMemoryRateLimitStore>[0] = {}) {
  store = createMemoryRateLimitStore(initial);
  configureEtsyClient({
    store,
    now: () => now,
    sleep: async (ms) => {
      sleeps.push(ms);
      now += ms;
    },
    random: () => 0,
  });
}

beforeEach(() => {
  now = T0;
  sleeps.length = 0;
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "warn").mockImplementation(warn);
  vi.spyOn(console, "error").mockImplementation(error);
  warn.mockReset();
  error.mockReset();
  setup();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  configureEtsyClient("reset");
});

describe("parseRateLimitHeaders", () => {
  test("reads all four of Etsy's quota headers", () => {
    expect(
      parseRateLimitHeaders(
        new Headers({
          "x-limit-per-second": "10",
          "x-remaining-this-second": "7",
          "x-limit-per-day": "10000",
          "x-remaining-today": "9876",
        }),
      ),
    ).toEqual({ perSecondLimit: 10, remainingThisSecond: 7, perDayLimit: 10000, remainingToday: 9876 });
  });

  test("missing, empty or unreadable values are null", () => {
    expect(
      parseRateLimitHeaders(new Headers({ "x-limit-per-second": "", "x-limit-per-day": "lots", "x-remaining-today": "-3" })),
    ).toEqual({ perSecondLimit: null, remainingThisSecond: null, perDayLimit: null, remainingToday: null });
  });

  test("zero is kept as zero", () => {
    expect(parseRateLimitHeaders(new Headers({ "x-remaining-this-second": "0" })).remainingThisSecond).toBe(0);
  });
});

describe("retryDelayMs", () => {
  test("Retry-After in seconds", () => {
    expect(retryDelayMs(new Headers({ "retry-after": "2" }), 0)).toBe(2000);
  });

  test("Retry-After as an HTTP date", () => {
    expect(retryDelayMs(new Headers({ "retry-after": new Date(T0 + 3000).toUTCString() }), 0)).toBe(3000);
  });

  test("without Retry-After: exponential backoff plus jitter", () => {
    configureEtsyClient({ random: () => 0.5 });
    expect(retryDelayMs(null, 0)).toBe(625);
    expect(retryDelayMs(null, 1)).toBe(1125);
    expect(retryDelayMs(null, 2)).toBe(2125);
  });
});

describe("throttling", () => {
  test("uses the safe default per-second limit until Etsy reports one", async () => {
    fetchMock.mockResolvedValue(res(200));
    const seconds: number[] = [];
    fetchMock.mockImplementation(async () => {
      seconds.push(Math.floor((now - T0) / 1000));
      return res(200);
    });
    for (let i = 0; i < DEFAULT_PER_SECOND + 2; i++) await etsyRequest(URL_);
    expect(seconds.filter((s) => s === 0)).toHaveLength(DEFAULT_PER_SECOND);
    expect(seconds.filter((s) => s === 1)).toHaveLength(2);
    expect(sleeps).toEqual([1000]);
  });

  test("throttles to the per-second limit from Etsy's headers, not a hard-coded one", async () => {
    const seconds: number[] = [];
    fetchMock.mockImplementation(async () => {
      seconds.push(Math.floor((now - T0) / 1000));
      return res(200, { "x-limit-per-second": "2", "x-limit-per-day": "10000", "x-remaining-today": "9000" });
    });
    for (let i = 0; i < 5; i++) await etsyRequest(URL_);
    expect(seconds).toEqual([0, 0, 1, 1, 2]);
    expect(store.state.perSecondLimit).toBe(2);
    expect(store.state.perDayLimit).toBe(10000);
    expect(store.state.remainingToday).toBe(9000);
  });

  test("a response with no remaining requests this second pauses everyone until the next second", async () => {
    now = T0 + 300;
    fetchMock.mockResolvedValueOnce(res(200, { "x-remaining-this-second": "0" })).mockResolvedValue(res(200));
    await etsyRequest(URL_);
    await etsyRequest(URL_);
    expect(sleeps).toEqual([700]);
  });

  test("the slot count is shared across concurrent callers", async () => {
    setup({ perSecondLimit: 3 });
    let waiting = 0;
    configureEtsyClient({ sleep: () => (waiting++, new Promise<void>(() => {})) });
    fetchMock.mockResolvedValue(res(200));
    for (let i = 0; i < 6; i++) void etsyRequest(URL_);
    await vi.waitFor(() => expect(waiting).toBe(3));
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  test("logs each throttle with the endpoint and user id", async () => {
    setup({ perSecondLimit: 1 });
    fetchMock.mockResolvedValue(res(200));
    await withEtsyContext({ userId: "user-7" }, async () => {
      await etsyRequest(URL_);
      await etsyRequest(URL_);
    });
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/throttle GET \/v3\/application\/shops\/1\/listings user=user-7/));
  });
});

describe("429", () => {
  test("waits for Retry-After, then retries", async () => {
    fetchMock.mockResolvedValueOnce(res(429, { "retry-after": "3" })).mockResolvedValue(res(200));
    const out = await etsyRequest(URL_, {}, { userId: "u1" });
    expect(out.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sleeps).toContain(3000);
    expect(store.state.pausedUntilMs).toBe(T0 + 3000);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/retry GET \/v3\/application\/shops\/1\/listings user=u1 429/));
  });

  test("without Retry-After, backs off exponentially", async () => {
    fetchMock
      .mockResolvedValueOnce(res(429))
      .mockResolvedValueOnce(res(429))
      .mockResolvedValue(res(200));
    await etsyRequest(URL_);
    expect(sleeps).toEqual([500, 1000]);
  });

  test("gives up after the retry limit with a clear limit error", async () => {
    fetchMock.mockResolvedValue(res(429, { "retry-after": "1" }));
    const err = await etsyRequest(URL_, {}, { userId: "u1" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EtsyLimitError);
    expect(err).toBeInstanceOf(EtsyApiError);
    expect((err as EtsyLimitError).status).toBe(429);
    expect((err as Error).message).toMatch(/^Etsy limit reached, try again after 12:00 UTC\.$/);
    expect(fetchMock).toHaveBeenCalledTimes(MAX_RATE_LIMIT_RETRIES + 1);
    expect(error).toHaveBeenCalledWith(expect.stringMatching(/give-up GET \/v3\/application\/shops\/1\/listings user=u1 429/));
  });

  test("a Retry-After too long to wait inside a request is reported straight away", async () => {
    fetchMock.mockResolvedValue(res(429, { "retry-after": "600" }));
    const err = await etsyRequest(URL_).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EtsyLimitError);
    expect((err as EtsyLimitError).retryAt.getTime()).toBe(T0 + 600_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("429 is retried for a POST too (Etsy didn't do the work)", async () => {
    fetchMock.mockResolvedValueOnce(res(429, { "retry-after": "0" })).mockResolvedValue(res(201));
    expect((await etsyRequest(URL_, { method: "POST" })).status).toBe(201);
  });
});

describe("5xx, network errors and other 4xx", () => {
  test("a GET 5xx retries with backoff up to the limit, then returns the response", async () => {
    fetchMock.mockResolvedValue(res(503));
    const out = await etsyRequest(URL_);
    expect(out.status).toBe(503);
    expect(fetchMock).toHaveBeenCalledTimes(MAX_SERVER_RETRIES + 1);
    expect(sleeps).toEqual([500, 1000, 2000]);
    expect(error).toHaveBeenCalledWith(expect.stringMatching(/give-up GET .* 503 after 3 retries/));
  });

  test("a 5xx that recovers returns the good response", async () => {
    fetchMock.mockResolvedValueOnce(res(500)).mockResolvedValue(res(200));
    expect((await etsyRequest(URL_, { method: "PATCH" })).status).toBe(200);
  });

  test("a POST 5xx is not retried — it may already have created something", async () => {
    fetchMock.mockResolvedValue(res(502));
    expect((await etsyRequest(URL_, { method: "POST" })).status).toBe(502);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("a network error retries, then is rethrown", async () => {
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));
    await expect(etsyRequest(URL_)).rejects.toThrow("fetch failed");
    expect(fetchMock).toHaveBeenCalledTimes(MAX_SERVER_RETRIES + 1);
  });

  test("a network error that recovers", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed")).mockResolvedValue(res(200));
    expect((await etsyRequest(URL_)).status).toBe(200);
  });

  test.each([400, 401, 403, 404, 409])("%i is never retried", async (status) => {
    fetchMock.mockResolvedValue(res(status));
    expect((await etsyRequest(URL_)).status).toBe(status);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sleeps).toEqual([]);
  });
});

describe("daily budget", () => {
  const low = (remainingToday: number, observedAtMs = T0) =>
    setup({ perDayLimit: 10_000, remainingToday, observedAtMs, perSecondLimit: 10 });

  test("background work stops at 20% remaining; interactive work carries on", async () => {
    low(900);
    fetchMock.mockResolvedValue(res(200));
    const err = await etsyRequest(URL_, {}, { priority: "background", userId: "u9" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EtsyLimitError);
    expect((err as Error).message).toBe("Etsy limit reached, try again after 13:00 UTC.");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/give-up GET \/v3\/application\/shops\/1\/listings user=u9 daily budget/));

    expect((await etsyRequest(URL_)).status).toBe(200);
  });

  test("scheduled work stops at 10%, so user work keeps the rest", async () => {
    low(1500);
    fetchMock.mockResolvedValue(res(200));
    await expect(etsyRequest(URL_, {}, { priority: "background" })).rejects.toBeInstanceOf(EtsyLimitError);
    expect((await etsyRequest(URL_, {}, { priority: "scheduled" })).status).toBe(200);
    low(900);
    await expect(etsyRequest(URL_, {}, { priority: "scheduled" })).rejects.toBeInstanceOf(EtsyLimitError);
    expect((await etsyRequest(URL_)).status).toBe(200);
  });

  test("interactive work stops at 2%; token refreshes never do", async () => {
    low(150);
    fetchMock.mockResolvedValue(res(200));
    await expect(etsyRequest(URL_)).rejects.toBeInstanceOf(EtsyLimitError);
    expect((await etsyRequest(URL_, { method: "POST" }, { priority: "critical" })).status).toBe(200);
  });

  test("the priority comes from the surrounding context", async () => {
    low(900);
    fetchMock.mockResolvedValue(res(200));
    await expect(withEtsyContext({ priority: "background" }, () => etsyRequest(URL_))).rejects.toBeInstanceOf(EtsyLimitError);
  });

  test("a low reading older than the recheck window lets requests through again", async () => {
    low(10, T0 - DAILY_RECHECK_MS);
    fetchMock.mockResolvedValue(res(200, { "x-remaining-today": "5000" }));
    expect((await etsyRequest(URL_, {}, { priority: "background" })).status).toBe(200);
    expect(store.state.remainingToday).toBe(5000);
  });

  test("the cutoff follows the headers of the last response", async () => {
    fetchMock.mockResolvedValue(res(200, { "x-limit-per-day": "10000", "x-remaining-today": "999" }));
    await etsyRequest(URL_, {}, { priority: "background" });
    await expect(etsyRequest(URL_, {}, { priority: "background" })).rejects.toBeInstanceOf(EtsyLimitError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("no cutoff before Etsy has reported a daily limit", async () => {
    fetchMock.mockResolvedValue(res(200));
    await expect(assertEtsyBudget("background")).resolves.toBeUndefined();
  });

  test("assertEtsyBudget / etsyBudgetError refuse new work up front", async () => {
    low(500);
    await expect(assertEtsyBudget("background")).rejects.toBeInstanceOf(EtsyLimitError);
    expect((await etsyBudgetError("background"))?.retryAt.getTime()).toBe(T0 + DAILY_RECHECK_MS);
    expect(await etsyBudgetError("interactive")).toBeNull();
  });
});

describe("every Etsy API call goes through lib/etsy/client.ts", () => {
  const root = path.resolve(__dirname, "../../..");
  const sources: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (name === "node_modules" || name === "__tests__" || name.startsWith(".")) continue;
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.(ts|tsx|js|mjs)$/.test(name)) sources.push(full);
    }
  };
  for (const dir of ["app", "lib", "scripts"]) walk(path.join(root, dir));
  for (const file of ["auth.ts", "proxy.ts"]) sources.push(path.join(root, file));
  const rel = (f: string) => path.relative(root, f);
  const read = (f: string) => {
    try {
      return readFileSync(f, "utf8");
    } catch {
      return "";
    }
  };

  test("only the client names Etsy's API host", () => {
    const offenders = sources
      .filter((f) => rel(f) !== path.join("lib", "etsy", "client.ts"))
      .filter((f) => /(open)?api\.etsy\.com/.test(read(f)))
      .map(rel);
    expect(offenders).toEqual([]);
  });

  test("no file that uses Etsy's API URLs calls fetch directly", () => {
    const offenders = sources
      .filter((f) => rel(f) !== path.join("lib", "etsy", "client.ts"))
      .filter((f) => /ETSY_ENDPOINTS\.(apiBase|token)|ETSY_API_ORIGIN/.test(read(f)))
      .filter((f) => /(?<![\w.$])fetch\s*\(/.test(read(f)))
      .map(rel);
    expect(offenders).toEqual([]);
  });

  test("the scan saw the files it should", () => {
    expect(sources.map(rel)).toEqual(expect.arrayContaining([path.join("lib", "etsy", "auth.ts"), path.join("lib", "etsy", "oauth.ts")]));
  });
});

describe("read cache", () => {
  const SHOP = "https://api.etsy.com/v3/application/shops/1/shipping-profiles";
  const auth = (token: string): RequestInit => ({ headers: { Authorization: `Bearer ${token}` } });

  test("a shop's reference data is read once per window, per token", async () => {
    setup({ perSecondLimit: 10 });
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ count: 1 }), { status: 200 }));
    expect(await (await etsyRequest(SHOP, auth("a"))).json()).toEqual({ count: 1 });
    expect(await (await etsyRequest(SHOP, auth("a"))).json()).toEqual({ count: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await etsyRequest(SHOP, auth("b"));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test("a write with the same token drops what was cached; readCacheMs 0 always asks Etsy", async () => {
    setup({ perSecondLimit: 10 });
    fetchMock.mockImplementation(async () => new Response("{}", { status: 200 }));
    await etsyRequest(SHOP, auth("a"));
    await etsyRequest("https://api.etsy.com/v3/application/shops/1/listings/5", { ...auth("a"), method: "PATCH" });
    await etsyRequest(SHOP, auth("a"));
    expect(fetchMock).toHaveBeenCalledTimes(3);
    await withEtsyContext({ readCacheMs: 0 }, () => etsyRequest(SHOP, auth("a")));
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  test("listing pages and failed responses are never cached", async () => {
    setup({ perSecondLimit: 10 });
    fetchMock.mockImplementation(async () => new Response("{}", { status: 404 }));
    await etsyRequest(SHOP, auth("a"));
    await etsyRequest(SHOP, auth("a"));
    fetchMock.mockImplementation(async () => new Response("{}", { status: 200 }));
    await etsyRequest(URL_, auth("a"));
    await etsyRequest(URL_, auth("a"));
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });
});
