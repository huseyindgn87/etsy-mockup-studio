import { NextRequest } from "next/server";
import { beforeEach, describe, expect, test, vi } from "vitest";

// A plain `vi.fn()` (not typed against the real, overloaded `auth` export)
// sidesteps TS picking the wrong overload (the Proxy-wrapping one) when this
// mock is later called with `.mockResolvedValue(...)`.
const { authMock } = vi.hoisted(() => ({ authMock: vi.fn() }));
vi.mock("@/auth", () => ({ auth: authMock }));

interface Row {
  id: string;
  userId: string;
  contentHash: string;
  data: unknown;
}
const store = new Map<string, Row>();
const key = (userId: string, contentHash: string) => `${userId}:${contentHash}`;

vi.mock("@/lib/db/prisma", () => ({
  prisma: {
    mockupCalibration: {
      findUnique: vi.fn(
        async ({ where }: { where: { userId_contentHash: { userId: string; contentHash: string } } }) =>
          store.get(key(where.userId_contentHash.userId, where.userId_contentHash.contentHash)) ?? null,
      ),
      upsert: vi.fn(
        async ({
          where,
          create,
          update,
        }: {
          where: { userId_contentHash: { userId: string; contentHash: string } };
          create: { userId: string; contentHash: string; data: unknown };
          update: { data: unknown };
        }) => {
          const k = key(where.userId_contentHash.userId, where.userId_contentHash.contentHash);
          const existing = store.get(k);
          const row: Row = existing
            ? { ...existing, data: update.data }
            : { id: `row-${store.size + 1}`, userId: create.userId, contentHash: create.contentHash, data: create.data };
          store.set(k, row);
          return row;
        },
      ),
    },
  },
}));

import { GET, PUT } from "@/app/api/mockups/calibrations/route";

const HASH = "a".repeat(64);

function getReq(hash?: string) {
  const url = new URL("http://localhost/api/mockups/calibrations");
  if (hash !== undefined) url.searchParams.set("contentHash", hash);
  return new NextRequest(url);
}
function putReq(body: unknown) {
  return new Request("http://localhost/api/mockups/calibrations", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("mockup calibrations API", () => {
  beforeEach(() => {
    store.clear();
    authMock.mockClear();
    authMock.mockResolvedValue({
      user: { id: "u1", email: "seller@example.com" },
    });
  });

  test("GET 401 when not signed in", async () => {
    authMock.mockResolvedValueOnce(null);
    const res = await GET(getReq(HASH));
    expect(res.status).toBe(401);
  });

  test("GET 400 without a contentHash", async () => {
    const res = await GET(getReq());
    expect(res.status).toBe(400);
  });

  test("GET returns null before anything is saved", async () => {
    const res = await GET(getReq(HASH));
    expect(res.status).toBe(200);
    expect((await res.json()).calibration).toBeNull();
  });

  test("PUT saves, and a later GET returns the same (validated) calibration", async () => {
    const put = await PUT(
      putReq({ contentHash: HASH, calibration: { shade: 77, disp: 999, qs: "not-an-array" } }),
    );
    expect(put.status).toBe(200);
    const saved = (await put.json()).calibration;
    expect(saved.shade).toBe(77);
    expect(saved.disp).toBe(40); // clamped to the tool's max
    expect(Array.isArray(saved.qs)).toBe(true); // garbage qs replaced with the default quad

    const get = await GET(getReq(HASH));
    expect((await get.json()).calibration).toEqual(saved);
  });

  test("PUT overwrites a previously saved calibration for the same hash", async () => {
    await PUT(putReq({ contentHash: HASH, calibration: { shade: 10 } }));
    const second = await PUT(putReq({ contentHash: HASH, calibration: { shade: 90 } }));
    expect((await second.json()).calibration.shade).toBe(90);
    expect(store.size).toBe(1);
  });

  test("PUT 400 on a malformed contentHash", async () => {
    const res = await PUT(putReq({ contentHash: "not-hex!!", calibration: {} }));
    expect(res.status).toBe(400);
  });

  test("PUT 401 when not signed in", async () => {
    authMock.mockResolvedValueOnce(null);
    const res = await PUT(putReq({ contentHash: HASH, calibration: {} }));
    expect(res.status).toBe(401);
  });

  test("a second user's GET never sees the first user's saved calibration", async () => {
    await PUT(putReq({ contentHash: HASH, calibration: { shade: 55 } }));

    authMock.mockResolvedValueOnce({
      user: { id: "u2", email: "other@example.com" },
    });
    const res = await GET(getReq(HASH));
    expect((await res.json()).calibration).toBeNull();
  });
});
