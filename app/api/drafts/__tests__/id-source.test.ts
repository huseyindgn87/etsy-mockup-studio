import { beforeEach, describe, expect, test, vi } from "vitest";

// A plain `vi.fn()` (not typed against the real, overloaded `auth` export)
// sidesteps TS picking the wrong overload (the Proxy-wrapping one) when this
// mock is later called with `.mockResolvedValue(...)`.
const { authMock } = vi.hoisted(() => ({ authMock: vi.fn() }));
vi.mock("@/auth", () => ({ auth: authMock }));

interface Row {
  id: string;
  userId: string;
  title: string;
  formData: unknown;
  photosData: unknown;
  hasThumbnail: boolean;
  sourceMode: string | null;
  sourceListingId: string | null;
  updatedAt: Date;
}

const rows = new Map<string, Row>();

vi.mock("@/lib/drafts/store", () => ({
  getDraftRow: vi.fn(async (userId: string, id: string) => {
    const row = rows.get(id);
    if (!row || row.userId !== userId) return null;
    return row;
  }),
  saveDraft: vi.fn(async (userId: string, id: string, patch: Partial<Row>) => {
    const row = rows.get(id);
    if (!row || row.userId !== userId) return null;
    Object.assign(row, patch, { updatedAt: new Date() });
    return row;
  }),
  deleteDraft: vi.fn(async () => true),
}));

import { GET, PUT } from "@/app/api/drafts/[id]/route";

function makeRow(id: string, overrides: Partial<Row> = {}): Row {
  return {
    id,
    userId: "u1",
    title: "",
    formData: {},
    photosData: {},
    hasThumbnail: false,
    sourceMode: null,
    sourceListingId: null,
    updatedAt: new Date(),
    ...overrides,
  };
}

function getReq(id: string) {
  return new Request(`http://localhost/api/drafts/${id}`);
}
function putReq(id: string, body: unknown) {
  return new Request(`http://localhost/api/drafts/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}
const withId = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  rows.clear();
  authMock.mockClear();
  authMock.mockResolvedValue({
    user: { id: "u1", email: "seller@example.com" },
  });
});

describe("GET/PUT /api/drafts/[id] — copy/existing source persistence", () => {
  test("GET reports a null source for a from-scratch draft", async () => {
    rows.set("d1", makeRow("d1"));
    const res = await GET(getReq("d1"), withId("d1"));
    expect((await res.json()).source).toBeNull();
  });

  test("PUT with a copy source persists it, and a later GET returns it", async () => {
    rows.set("d1", makeRow("d1"));
    const put = await PUT(
      putReq("d1", { formData: { title: "Copy" }, source: { mode: "copy", listingId: 123 } }),
      withId("d1"),
    );
    expect(put.status).toBe(200);

    const get = await GET(getReq("d1"), withId("d1"));
    expect((await get.json()).source).toEqual({ mode: "copy", listingId: 123 });
  });

  test("PUT with an existing-listing source persists it too", async () => {
    rows.set("d1", makeRow("d1"));
    await PUT(putReq("d1", { source: { mode: "existing", listingId: 777 } }), withId("d1"));
    const get = await GET(getReq("d1"), withId("d1"));
    expect((await get.json()).source).toEqual({ mode: "existing", listingId: 777 });
  });

  test("PUT with source: null clears a previously saved source", async () => {
    rows.set("d1", makeRow("d1", { sourceMode: "existing", sourceListingId: "999" }));
    await PUT(putReq("d1", { source: null }), withId("d1"));
    const get = await GET(getReq("d1"), withId("d1"));
    expect((await get.json()).source).toBeNull();
  });

  test("PUT ignores a malformed source instead of writing garbage", async () => {
    rows.set("d1", makeRow("d1", { sourceMode: "copy", sourceListingId: "5" }));
    await PUT(putReq("d1", { source: { mode: "bogus", listingId: 5 } }), withId("d1"));
    const get = await GET(getReq("d1"), withId("d1"));
    // unchanged — the malformed write was silently dropped, not applied
    expect((await get.json()).source).toEqual({ mode: "copy", listingId: 5 });
  });

  test("PUT without a source key at all leaves a previously saved source untouched", async () => {
    rows.set("d1", makeRow("d1", { sourceMode: "existing", sourceListingId: "42" }));
    await PUT(putReq("d1", { formData: { title: "still editing" } }), withId("d1"));
    const get = await GET(getReq("d1"), withId("d1"));
    expect((await get.json()).source).toEqual({ mode: "existing", listingId: 42 });
  });

  test("GET 401 when not signed in", async () => {
    authMock.mockResolvedValueOnce(null);
    rows.set("d1", makeRow("d1"));
    const res = await GET(getReq("d1"), withId("d1"));
    expect(res.status).toBe(401);
  });

  test("GET 404 for another user's draft — never leaks someone else's data", async () => {
    rows.set("d1", makeRow("d1", { userId: "someone-else" }));
    const res = await GET(getReq("d1"), withId("d1"));
    expect(res.status).toBe(404);
  });
});
