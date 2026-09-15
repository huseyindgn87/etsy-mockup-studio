import { beforeEach, describe, expect, test, vi } from "vitest";

const { authMock, stored, r2State } = vi.hoisted(() => ({
  authMock: vi.fn(),
  stored: new Map<string, { bytes: number; contentType: string }>(),
  r2State: { configured: true },
}));
vi.mock("@/auth", () => ({ auth: authMock }));
vi.mock("@/lib/etsy/listing-create", () => ({}));
vi.mock("@/lib/db/prisma", async () => ({
  prisma: (await import("@/lib/scheduling/__tests__/fake-prisma")).fakePrisma,
}));
vi.mock("@/lib/storage/r2", () => ({
  isR2Configured: () => r2State.configured,
  listKeys: async (prefix: string) => [...stored.keys()].filter((k) => k.startsWith(prefix)),
  putObject: async (key: string, body: Buffer, contentType: string) => {
    stored.set(key, { bytes: body.length, contentType });
  },
  deletePrefix: async (prefix: string) => {
    for (const k of [...stored.keys()]) if (k.startsWith(prefix)) stored.delete(k);
  },
}));

import { PUT } from "@/app/api/schedule/renders/[setId]/[slot]/route";
import { DELETE } from "@/app/api/schedule/renders/[setId]/route";
import { resetDb, seedScheduled } from "@/lib/scheduling/__tests__/fake-prisma";
import { SET_A, SET_B } from "@/lib/scheduling/__tests__/fixtures";

function put(setId: string, slot: string, bytes: Uint8Array | number, contentType = "image/jpeg") {
  const data = typeof bytes === "number" ? new Uint8Array(bytes) : bytes;
  const body = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
  return PUT(
    new Request(`http://localhost/api/schedule/renders/${setId}/${slot}`, {
      method: "PUT",
      headers: { "Content-Type": contentType },
      body,
    }),
    { params: Promise.resolve({ setId, slot }) },
  );
}
function del(setId: string) {
  return DELETE(new Request(`http://localhost/api/schedule/renders/${setId}`, { method: "DELETE" }), {
    params: Promise.resolve({ setId }),
  });
}

beforeEach(() => {
  resetDb();
  stored.clear();
  r2State.configured = true;
  authMock.mockResolvedValue({ user: { id: "alice" } });
});

describe("PUT /api/schedule/renders/[setId]/[slot]", () => {
  test("stores the image under the signed-in user's scheduled-job prefix", async () => {
    const res = await put(SET_A, "image-00", 1024);
    expect(res.status).toBe(200);
    expect(stored.get(`scheduled/alice/${SET_A}/image-00`)).toEqual({ bytes: 1024, contentType: "image/jpeg" });
  });

  test("accepts all 20 slots, image-00 through image-19, and rejects a 21st", async () => {
    for (let i = 0; i < 20; i++) {
      expect((await put(SET_A, `image-${String(i).padStart(2, "0")}`, 10)).status).toBe(200);
    }
    expect(stored.size).toBe(20);
    expect((await put(SET_A, "image-20", 10)).status).toBe(400);
    expect(stored.size).toBe(20);
  });

  test("rejects bad slots and set ids, unsupported types, empty and oversized images", async () => {
    expect((await put(SET_A, "../../drafts/x", 10)).status).toBe(400);
    expect((await put("not-a-uuid", "image-00", 10)).status).toBe(400);
    expect((await put(SET_A, "image-00", 10, "image/webp")).status).toBe(415);
    expect((await put(SET_A, "image-00", 0)).status).toBe(400);
    expect((await put(SET_A, "image-00", 10 * 1024 * 1024 + 1)).status).toBe(413);
    expect(stored.size).toBe(0);
  });

  test("tells the user why when storage isn't configured", async () => {
    r2State.configured = false;
    const res = await put(SET_A, "image-00", 10);
    expect(res.status).toBe(503);
    expect((await res.json()).error).toMatch(/storage \(R2\) isn't set up/);
  });

  test("won't overwrite images that already belong to a schedule", async () => {
    seedScheduled({ userId: "alice", shopId: "s", scheduledAt: new Date(), renderSetId: SET_A });
    expect((await put(SET_A, "image-00", 10)).status).toBe(409);
  });

  test("401 when signed out; another user's upload lands under their own prefix", async () => {
    authMock.mockResolvedValueOnce(null);
    expect((await put(SET_A, "image-00", 10)).status).toBe(401);

    authMock.mockResolvedValue({ user: { id: "bob" } });
    await put(SET_A, "image-00", 10);
    expect([...stored.keys()]).toEqual([`scheduled/bob/${SET_A}/image-00`]);
  });
});

describe("DELETE /api/schedule/renders/[setId]", () => {
  test("discards an unused set — and only that set", async () => {
    stored.set(`scheduled/alice/${SET_A}/image-00`, { bytes: 1, contentType: "image/jpeg" });
    stored.set(`scheduled/alice/${SET_B}/image-00`, { bytes: 1, contentType: "image/jpeg" });
    stored.set("drafts/d1/own/photo", { bytes: 1, contentType: "image/jpeg" });
    expect((await del(SET_A)).status).toBe(200);
    expect([...stored.keys()].sort()).toEqual(["drafts/d1/own/photo", `scheduled/alice/${SET_B}/image-00`]);
  });

  test("refuses to discard a set a schedule uses", async () => {
    seedScheduled({ userId: "alice", shopId: "s", scheduledAt: new Date(), renderSetId: SET_A });
    stored.set(`scheduled/alice/${SET_A}/image-00`, { bytes: 1, contentType: "image/jpeg" });
    expect((await del(SET_A)).status).toBe(409);
    expect(stored.size).toBe(1);
  });
});
