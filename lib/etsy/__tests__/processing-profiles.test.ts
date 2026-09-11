import { beforeEach, describe, expect, test, vi } from "vitest";

const etsyFetch = vi.fn<(path: string) => Promise<Response>>();
vi.mock("@/lib/etsy/auth", () => ({ etsyFetch: (path: string) => etsyFetch(path) }));

import { getShopProcessingProfiles } from "@/lib/etsy/processing-profiles";

const json = (body: unknown, ok = true, status = 200): Response =>
  ({ ok, status, json: async () => body }) as Response;

beforeEach(() => {
  etsyFetch.mockReset();
});

describe("getShopProcessingProfiles", () => {
  test("maps fields (snake_case -> camelCase) and caches per shop", async () => {
    let profileCalls = 0;
    etsyFetch.mockImplementation(async (path: string) => {
      if (path.includes("/users/me")) return json({ user_id: 1, shop_id: 55 });
      if (path === "/shops/55/readiness-state-definitions") {
        profileCalls++;
        return json({
          count: 1,
          results: [
            {
              readiness_state_id: 321,
              readiness_state: "made_to_order",
              min_processing_days: 3,
              max_processing_days: 5,
              processing_days_display_label: "3 - 5 days",
            },
          ],
        });
      }
      throw new Error(`unexpected path: ${path}`);
    });

    const profiles = await getShopProcessingProfiles();
    expect(profiles).toEqual([
      {
        readinessStateId: 321,
        readinessState: "made_to_order",
        minProcessingDays: 3,
        maxProcessingDays: 5,
        displayLabel: "3 - 5 days",
      },
    ]);

    await getShopProcessingProfiles();
    expect(profileCalls).toBe(1); // second call served from cache
  });

  test("returns an empty list when the shop has no processing profiles", async () => {
    etsyFetch.mockImplementation(async (path: string) => {
      if (path.includes("/users/me")) return json({ user_id: 1, shop_id: 56 });
      if (path === "/shops/56/readiness-state-definitions") return json({ count: 0, results: [] });
      throw new Error(`unexpected path: ${path}`);
    });
    expect(await getShopProcessingProfiles()).toEqual([]);
  });
});
