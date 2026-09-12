import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const etsyFetch = vi.fn<(path: string) => Promise<Response>>();
vi.mock("@/lib/etsy/auth", () => ({ etsyFetch: (path: string) => etsyFetch(path) }));

import { getListingCopySource } from "@/lib/etsy/listing-copy";

const json = (body: unknown, ok = true, status = 200): Response =>
  ({ ok, status, json: async () => body, text: async () => JSON.stringify(body) }) as Response;

beforeEach(() => {
  etsyFetch.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("getListingCopySource", () => {
  test("maps title/description/tags/price/section, decoding HTML entities", async () => {
    etsyFetch.mockResolvedValue(
      json({
        listing_id: 1,
        title: "I&#39;d Rather &gt;&gt;SALE&lt;&lt;",
        description: "Cozy &amp; warm",
        tags: ["mug", "gift"],
        price: { amount: 1999, divisor: 100, currency_code: "USD" },
        shop_section_id: 42,
        images: [],
      }),
    );

    const src = await getListingCopySource(1);
    expect(src.title).toBe("I'd Rather >>SALE<<");
    expect(src.description).toBe("Cozy & warm");
    expect(src.tags).toEqual(["mug", "gift"]);
    expect(src.price).toBe(19.99);
    expect(src.shopSectionId).toBe(42);
    expect(src.images).toEqual([]);
  });

  test("maps a missing/zero shop_section_id and a missing price to null", async () => {
    etsyFetch.mockResolvedValue(
      json({ listing_id: 2, title: "No section", images: [], shop_section_id: 0 }),
    );

    const src = await getListingCopySource(2);
    expect(src.shopSectionId).toBeNull();
    expect(src.price).toBeNull();
  });

  test("downloads each photo as a data URL, preferring the largest available size", async () => {
    etsyFetch.mockResolvedValue(
      json({
        listing_id: 3,
        title: "Two photos",
        images: [
          { url_fullxfull: "https://img/full1.jpg", url_570xN: "https://img/570-1.jpg" },
          { url_570xN: "https://img/570-2.jpg" },
        ],
      }),
    );
    const fetchImpl = vi.fn(async (url: string) => ({
      ok: true,
      headers: { get: () => "image/jpeg" },
      arrayBuffer: async () => new TextEncoder().encode(`bytes:${url}`).buffer,
    }));
    vi.stubGlobal("fetch", fetchImpl);

    const src = await getListingCopySource(3);
    expect(fetchImpl).toHaveBeenCalledWith("https://img/full1.jpg");
    expect(fetchImpl).toHaveBeenCalledWith("https://img/570-2.jpg");
    expect(src.images).toHaveLength(2);
    expect(src.images[0].dataUrl).toMatch(/^data:image\/jpeg;base64,/);
    expect(src.images[0].fileName).toBe("photo-1.jpg");
  });

  test("skips a photo that fails to download instead of failing the whole request", async () => {
    etsyFetch.mockResolvedValue(
      json({
        listing_id: 4,
        title: "One good, one bad",
        images: [{ url_570xN: "https://img/ok.jpg" }, { url_570xN: "https://img/bad.jpg" }],
      }),
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("bad")) return { ok: false, status: 404 } as Response;
        return {
          ok: true,
          headers: { get: () => "image/png" },
          arrayBuffer: async () => new TextEncoder().encode("ok").buffer,
        } as unknown as Response;
      }),
    );

    const src = await getListingCopySource(4);
    expect(src.images).toHaveLength(1);
    expect(src.images[0].fileName).toBe("photo-1.png");
  });

  test("never calls any write-capable Etsy endpoint — only the single-listing GET", async () => {
    etsyFetch.mockResolvedValue(json({ listing_id: 5, title: "Read only", images: [] }));
    await getListingCopySource(5);
    expect(etsyFetch).toHaveBeenCalledTimes(1);
    expect(etsyFetch).toHaveBeenCalledWith("/listings/5?includes=Images");
  });
});
