import { describe, expect, test, vi } from "vitest";
import { TtlCache } from "@/lib/etsy/cache";

describe("TtlCache", () => {
  test("serves a cache hit within the TTL without calling the fetcher again", async () => {
    const cache = new TtlCache<string, number>(10_000);
    const fetcher = vi.fn(async () => 1);

    expect(await cache.get("a", fetcher)).toBe(1);
    expect(await cache.get("a", fetcher)).toBe(1);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  test("re-fetches once the TTL has elapsed", async () => {
    const cache = new TtlCache<string, number>(5);
    let value = 1;
    const fetcher = vi.fn(async () => value);

    expect(await cache.get("a", fetcher)).toBe(1);
    value = 2;
    await new Promise((r) => setTimeout(r, 15));
    expect(await cache.get("a", fetcher)).toBe(2);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  test("different keys are cached independently", async () => {
    const cache = new TtlCache<string, number>(10_000);
    const fetcher = vi.fn(async (k: string) => k.length);

    await cache.get("a", () => fetcher("a"));
    await cache.get("bb", () => fetcher("bb"));
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  test("de-duplicates concurrent in-flight calls for the same key into one fetch", async () => {
    const cache = new TtlCache<string, number>(10_000);
    let calls = 0;
    const fetcher = vi.fn(async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 10));
      return 42;
    });

    const [a, b] = await Promise.all([cache.get("k", fetcher), cache.get("k", fetcher)]);
    expect(a).toBe(42);
    expect(b).toBe(42);
    expect(calls).toBe(1);
  });

  test("does not cache a rejected fetch — the next call retries", async () => {
    const cache = new TtlCache<string, number>(10_000);
    const fetcher = vi
      .fn<() => Promise<number>>()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce(7);

    await expect(cache.get("a", fetcher)).rejects.toThrow("boom");
    expect(await cache.get("a", fetcher)).toBe(7);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
