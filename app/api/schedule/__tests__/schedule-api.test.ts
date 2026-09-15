import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// Real routes + real lib/scheduling/store.ts over an in-memory Prisma
// (lib/scheduling/__tests__/fake-prisma.ts) and an in-memory R2. Only the
// app session and "which Etsy shop is active" are mocked.

const { authMock, shopMock, stored, r2State } = vi.hoisted(() => ({
  authMock: vi.fn(),
  shopMock: vi.fn(),
  stored: new Set<string>(),
  r2State: { configured: true },
}));
vi.mock("@/auth", () => ({ auth: authMock }));
vi.mock("@/lib/etsy/listing-store", () => {
  class NotConnectedError extends Error {
    constructor() {
      super("Not connected to Etsy.");
    }
  }
  return { NotConnectedError, resolveActiveShopId: shopMock };
});
vi.mock("@/lib/etsy/listings", () => ({ EtsyApiError: class EtsyApiError extends Error {} }));
vi.mock("@/lib/etsy/listing-create", () => ({}));
vi.mock("@/lib/db/prisma", async () => ({
  prisma: (await import("@/lib/scheduling/__tests__/fake-prisma")).fakePrisma,
}));
vi.mock("@/lib/storage/r2", () => ({
  isR2Configured: () => r2State.configured,
  listKeys: async (prefix: string) => [...stored].filter((k) => k.startsWith(prefix)),
  putObject: async (key: string) => {
    stored.add(key);
  },
  deleteObjects: vi.fn(async (keys: string[]) => {
    for (const k of keys) stored.delete(k);
  }),
  deletePrefix: async (prefix: string) => {
    for (const k of [...stored]) if (k.startsWith(prefix)) stored.delete(k);
  },
}));

import { NextRequest } from "next/server";
import { GET, POST } from "@/app/api/schedule/route";
import { PATCH } from "@/app/api/schedule/[id]/route";
import { POST as CANCEL } from "@/app/api/schedule/[id]/cancel/route";
import { NotConnectedError } from "@/lib/etsy/listing-store";
import { db, resetDb, seedDraft, seedScheduled } from "@/lib/scheduling/__tests__/fake-prisma";
import { imageMeta, SET_A, SET_B, storedImages, VALID_SPEC } from "@/lib/scheduling/__tests__/fixtures";
import { renderImageKey } from "@/lib/scheduling/render-keys";
import { utcToWallTime } from "@/lib/scheduling/timezone";
import type { ScheduledListingSummary } from "@/lib/scheduling/types";
import { deleteObjects } from "@/lib/storage/r2";

const NOW = new Date("2026-09-16T12:00:00Z");

/** Which shop each test user currently has active. */
const activeShop: Record<string, string> = {};

function signInAs(userId: string, shopId: string) {
  activeShop[userId] = shopId;
  authMock.mockResolvedValue({ user: { id: userId } });
  shopMock.mockImplementation(async (uid: string) => activeShop[uid]);
}

function upload(userId: string, set: string, count: number) {
  for (let i = 0; i < count; i++) stored.add(renderImageKey(userId, set, i));
}

const json = (body: unknown) => ({
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});
const withId = (id: string) => ({ params: Promise.resolve({ id }) });

/** A complete create body for alice's draft with 3 uploaded images. */
function body(overrides: Record<string, unknown> = {}) {
  return {
    draftId: "draft-alice",
    date: "2026-09-20",
    time: "14:30",
    timezone: "UTC",
    publishSpec: VALID_SPEC,
    renderSetId: SET_A,
    images: imageMeta(3),
    ...overrides,
  };
}

async function create(b: unknown) {
  const res = await POST(new Request("http://localhost/api/schedule", { method: "POST", ...json(b) }));
  return { status: res.status, body: await res.json() };
}
async function list(query: Record<string, string>) {
  const res = await GET(new NextRequest(`http://localhost/api/schedule?${new URLSearchParams(query)}`));
  return { status: res.status, body: await res.json() };
}
async function listRange(from: string, to: string): Promise<ScheduledListingSummary[]> {
  const { status, body: b } = await list({ from, to });
  expect(status).toBe(200);
  return b.scheduledListings;
}
async function reschedule(id: string, b: unknown) {
  const res = await PATCH(
    new Request(`http://localhost/api/schedule/${id}`, { method: "PATCH", ...json(b) }),
    withId(id),
  );
  return { status: res.status, body: await res.json() };
}
async function cancel(id: string) {
  const res = await CANCEL(new Request(`http://localhost/api/schedule/${id}/cancel`, { method: "POST" }), withId(id));
  return { status: res.status, body: await res.json() };
}

const FORTNIGHT = { from: "2026-09-14T00:00:00.000Z", to: "2026-09-28T00:00:00.000Z" };

/** A schedule row for alice's draft, with its images stored. */
function aliceRow(overrides: Partial<Parameters<typeof seedScheduled>[0]> = {}) {
  upload("alice", SET_A, 3);
  return seedScheduled({
    userId: "alice",
    shopId: "shop-a",
    draftId: "draft-alice",
    activeDraftId: "draft-alice",
    scheduledAt: new Date("2026-09-20T09:00:00Z"),
    publishSpec: VALID_SPEC,
    renderSetId: SET_A,
    images: storedImages("alice", 3),
    ...overrides,
  });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  resetDb();
  stored.clear();
  r2State.configured = true;
  vi.mocked(deleteObjects).mockClear();
  authMock.mockReset();
  shopMock.mockReset();
  signInAs("alice", "shop-a");
  seedDraft({ id: "draft-alice", userId: "alice", title: "Halloween mug", hasThumbnail: true });
  seedDraft({ id: "draft-alice-2", userId: "alice", title: "Second mug" });
  seedDraft({ id: "draft-bob", userId: "bob", title: "Bob's poster" });
  upload("alice", SET_A, 3);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("POST /api/schedule — create", () => {
  test("stores the UTC instant, the listing content and the ordered image keys — and sends nothing to Etsy", async () => {
    const { status, body: b } = await create(body({ timezone: "Europe/Istanbul" }));
    expect(status).toBe(201);
    expect(b.scheduledListing).toMatchObject({
      draftId: "draft-alice",
      title: "Halloween mug",
      scheduledAt: "2026-09-20T11:30:00.000Z",
      timezone: "Europe/Istanbul",
      status: "pending",
      imageCount: 3,
      attemptCount: 0,
      etsyListingId: null,
    });

    const [row] = [...db.scheduled.values()];
    expect(row).toMatchObject({
      userId: "alice",
      shopId: "shop-a",
      draftId: "draft-alice",
      activeDraftId: "draft-alice",
      renderSetId: SET_A,
      images: storedImages("alice", 3),
    });
    expect(row.publishSpec).toMatchObject({ mode: "new", newListing: { title: "Halloween mug" } });
    expect(db.drafts.get("draft-alice")).toMatchObject({ title: "Halloween mug" });
  });

  test("rejects a time in the past and stores nothing", async () => {
    const { status, body: b } = await create(body({ date: "2026-09-16", time: "11:59" }));
    expect(status).toBe(400);
    expect(b.error).toMatch(/in the past/);
    expect(db.scheduled.size).toBe(0);
  });

  test("judges the past in the chosen timezone (14:30 Istanbul is already gone at 12:00 UTC)", async () => {
    expect((await create(body({ date: "2026-09-16", timezone: "Europe/Istanbul" }))).status).toBe(400);
    expect((await create(body({ date: "2026-09-16", timezone: "America/New_York" }))).status).toBe(201);
  });

  test("accepts a listing with 20 images", async () => {
    upload("alice", SET_B, 20);
    const { status, body: b } = await create(body({ renderSetId: SET_B, images: imageMeta(20) }));
    expect(status).toBe(201);
    expect(b.scheduledListing.imageCount).toBe(20);
    const [row] = [...db.scheduled.values()];
    expect((row.images as { key: string }[]).map((i) => i.key)).toEqual(
      Array.from({ length: 20 }, (_, i) => renderImageKey("alice", SET_B, i)),
    );
  });

  test("rejects 21 images", async () => {
    const { status, body: b } = await create(body({ images: imageMeta(21) }));
    expect(status).toBe(400);
    expect(b.error).toBe("A listing can have at most 20 images.");
  });

  test("blocks scheduling when some images never reached storage, and says so", async () => {
    stored.delete(renderImageKey("alice", SET_A, 2));
    const { status, body: b } = await create(body());
    expect(status).toBe(400);
    expect(b.error).toMatch(/1 of the rendered images didn't finish uploading/);
    expect(db.scheduled.size).toBe(0);
  });

  test("blocks scheduling with a clear message when storage isn't configured", async () => {
    r2State.configured = false;
    const { status, body: b } = await create(body());
    expect(status).toBe(503);
    expect(b.error).toMatch(/storage \(R2\) isn't set up/);
  });

  test.each([
    ["no draftId", { draftId: undefined }],
    ["an unknown timezone", { timezone: "Nowhere/Town" }],
    ["no time", { time: undefined }],
    ["adding photos to an existing listing", { publishSpec: { ...VALID_SPEC, mode: "existing", listingId: 5 } }],
    ["no images", { images: [] }],
    ["a malformed render set id", { renderSetId: "../../drafts" }],
  ])("400 for %s", async (_label, overrides) => {
    expect((await create(body(overrides))).status).toBe(400);
    expect(db.scheduled.size).toBe(0);
  });

  test("401 when signed out, and when no Etsy shop is connected", async () => {
    authMock.mockResolvedValueOnce(null);
    expect((await create(body())).status).toBe(401);
    shopMock.mockRejectedValueOnce(new NotConnectedError());
    expect((await create(body())).status).toBe(401);
    expect(db.scheduled.size).toBe(0);
  });
});

describe("one active schedule per draft — enforced by the database's unique constraint", () => {
  test("a second schedule for the same draft is refused with 409", async () => {
    expect((await create(body())).status).toBe(201);
    upload("alice", SET_B, 3);
    const second = await create(body({ renderSetId: SET_B, time: "16:00" }));
    expect(second.status).toBe(409);
    expect(second.body.error).toMatch(/already scheduled/);
    expect(db.scheduled.size).toBe(1);
  });

  test("two simultaneous creates for one draft: exactly one wins", async () => {
    upload("alice", SET_B, 3);
    const results = await Promise.all([create(body()), create(body({ renderSetId: SET_B }))]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect([...db.scheduled.values()].filter((r) => r.activeDraftId === "draft-alice")).toHaveLength(1);
  });

  test("a failed schedule still holds the slot; cancelling or publishing releases it", async () => {
    aliceRow({ status: "failed", attemptCount: 3 });
    upload("alice", SET_B, 3);
    expect((await create(body({ renderSetId: SET_B }))).status).toBe(409);

    const [failedRow] = [...db.scheduled.values()];
    expect((await cancel(failedRow.id)).status).toBe(200);
    expect(db.scheduled.get(failedRow.id)!.activeDraftId).toBeNull();
    expect((await create(body({ renderSetId: SET_B }))).status).toBe(201);
  });

  test("other drafts are unaffected", async () => {
    expect((await create(body())).status).toBe(201);
    upload("alice", SET_B, 3);
    expect((await create(body({ draftId: "draft-alice-2", renderSetId: SET_B }))).status).toBe(201);
  });
});

describe("timezone round trip through the API", () => {
  test.each([
    ["Europe/Istanbul", "2026-09-20", "14:30"],
    ["America/Los_Angeles", "2026-11-01", "23:45"],
    ["Asia/Kolkata", "2026-09-17", "00:15"],
    ["Australia/Sydney", "2026-10-04", "03:00"],
  ])("%s %s %s is stored in UTC and reads back as the same wall time", async (timezone, date, time) => {
    const created = await create(body({ date, time, timezone }));
    expect(created.status).toBe(201);
    const summary: ScheduledListingSummary = created.body.scheduledListing;
    expect(summary.scheduledAt.endsWith("Z")).toBe(true);
    expect(utcToWallTime(new Date(summary.scheduledAt), timezone)).toEqual({ date, time });
  });
});

describe("GET /api/schedule — range filtering", () => {
  test("returns only rows in [from, to), soonest first, without cancelled ones", async () => {
    let n = 0;
    const at = (iso: string, extra: object = {}) =>
      seedScheduled({ userId: "alice", shopId: "shop-a", draftId: `d${n++}`, scheduledAt: new Date(iso), ...extra });
    at("2026-09-13T23:59:59.999Z");
    const atStart = at("2026-09-14T00:00:00.000Z");
    const late = at("2026-09-27T23:59:00.000Z");
    const mid = at("2026-09-20T09:00:00.000Z", { status: "failed", lastError: "Etsy said no" });
    const published = at("2026-09-18T09:00:00.000Z", { status: "published", etsyListingId: "999" });
    at("2026-09-19T09:00:00.000Z", { status: "cancelled" });
    at("2026-09-28T00:00:00.000Z");

    const rows = await listRange(FORTNIGHT.from, FORTNIGHT.to);
    expect(rows.map((r) => r.id)).toEqual([atStart.id, published.id, mid.id, late.id]);
    expect(rows.find((r) => r.id === mid.id)).toMatchObject({ status: "failed", lastError: "Etsy said no" });
  });

  test("400 for a missing, reversed or oversized range", async () => {
    expect((await list({ from: FORTNIGHT.from })).status).toBe(400);
    expect((await list({ from: FORTNIGHT.to, to: FORTNIGHT.from })).status).toBe(400);
    expect((await list({ from: "2026-01-01T00:00:00Z", to: "2026-12-31T00:00:00Z" })).status).toBe(400);
  });

  test("?draftId= returns just that draft's live schedule", async () => {
    seedScheduled({ userId: "alice", shopId: "shop-a", draftId: "draft-alice", scheduledAt: new Date("2026-09-01T00:00:00Z"), status: "cancelled" });
    const live = aliceRow();
    const { body: b } = await list({ draftId: "draft-alice" });
    expect(b.scheduledListings.map((r: ScheduledListingSummary) => r.id)).toEqual([live.id]);
  });
});

describe("PATCH /api/schedule/[id] — reschedule", () => {
  test("moves a pending schedule to the new instant and timezone, keeping its images", async () => {
    const row = aliceRow();
    const { status, body: b } = await reschedule(row.id, { date: "2026-09-25", time: "08:15", timezone: "America/New_York" });
    expect(status).toBe(200);
    expect(b.scheduledListing).toMatchObject({ scheduledAt: "2026-09-25T12:15:00.000Z", timezone: "America/New_York", status: "pending" });
    expect(db.scheduled.get(row.id)!.images).toEqual(storedImages("alice", 3));
    expect(deleteObjects).not.toHaveBeenCalled();
  });

  test("a failed schedule goes back to pending with attempts, backoff and error cleared", async () => {
    const row = aliceRow({
      scheduledAt: new Date("2026-09-15T09:00:00Z"),
      status: "failed",
      attemptCount: 3,
      nextAttemptAt: new Date("2026-09-15T09:20:00Z"),
      lastError: "Etsy 500",
      etsyListingId: "777",
    });
    const { status } = await reschedule(row.id, { date: "2026-09-21", time: "09:00", timezone: "UTC" });
    expect(status).toBe(200);
    expect(db.scheduled.get(row.id)).toMatchObject({
      status: "pending",
      attemptCount: 0,
      nextAttemptAt: null,
      lastError: null,
      // The retry finishes the listing Etsy already created.
      etsyListingId: "777",
      activeDraftId: "draft-alice",
    });
  });

  test("with freshly rendered content, replaces the spec and images and deletes only the old set's renders", async () => {
    const row = aliceRow({ etsyListingId: "777" });
    stored.add("drafts/draft-alice/own/photo-1"); // the user's own upload
    upload("alice", SET_B, 2);
    const { status, body: b } = await reschedule(row.id, {
      date: "2026-09-25",
      time: "10:00",
      timezone: "UTC",
      publishSpec: { ...VALID_SPEC, newListing: { ...VALID_SPEC.newListing, title: "Updated mug" } },
      renderSetId: SET_B,
      images: imageMeta(2),
    });
    expect(status).toBe(200);
    expect(b.scheduledListing.imageCount).toBe(2);
    const updated = db.scheduled.get(row.id)!;
    expect(updated).toMatchObject({ renderSetId: SET_B, images: storedImages("alice", 2, SET_B), etsyListingId: null });
    expect(updated.publishSpec).toMatchObject({ newListing: { title: "Updated mug" } });

    expect(deleteObjects).toHaveBeenCalledWith(storedImages("alice", 3).map((i) => i.key));
    expect(stored.has("drafts/draft-alice/own/photo-1")).toBe(true);
    expect(stored.has(renderImageKey("alice", SET_B, 0))).toBe(true);
  });

  test("a time-only reschedule of a schedule with no rendered images is refused", async () => {
    const row = aliceRow({ status: "failed", images: [], renderSetId: null });
    const { status, body: b } = await reschedule(row.id, { date: "2026-09-25", time: "10:00", timezone: "UTC" });
    expect(status).toBe(409);
    expect(b.error).toMatch(/no rendered images/);
  });

  test("rejects a past time and leaves the row alone", async () => {
    const row = aliceRow();
    const { status, body: b } = await reschedule(row.id, { date: "2026-09-10", time: "09:00", timezone: "UTC" });
    expect(status).toBe(400);
    expect(b.error).toMatch(/in the past/);
    expect(db.scheduled.get(row.id)!.scheduledAt.toISOString()).toBe("2026-09-20T09:00:00.000Z");
  });

  test.each(["publishing", "published", "cancelled"])("409 for a %s schedule, unchanged", async (statusValue) => {
    const row = aliceRow({ status: statusValue, activeDraftId: statusValue === "publishing" ? "draft-alice" : null });
    const { status } = await reschedule(row.id, { date: "2026-09-25", time: "09:00", timezone: "UTC" });
    expect(status).toBe(409);
    expect(db.scheduled.get(row.id)).toMatchObject({ status: statusValue });
  });

  test("404 for an id that doesn't exist", async () => {
    expect((await reschedule("nope", { date: "2026-09-25", time: "09:00", timezone: "UTC" })).status).toBe(404);
  });
});

describe("POST /api/schedule/[id]/cancel", () => {
  test("cancels a pending schedule, releases the draft and drops it off the calendar — the draft stays", async () => {
    const row = aliceRow();
    const { status, body: b } = await cancel(row.id);
    expect(status).toBe(200);
    expect(b.scheduledListing.status).toBe("cancelled");
    expect(db.scheduled.get(row.id)).toMatchObject({ status: "cancelled", activeDraftId: null });
    expect(await listRange(FORTNIGHT.from, FORTNIGHT.to)).toEqual([]);
    expect(db.drafts.has("draft-alice")).toBe(true);
  });

  test.each(["publishing", "published", "cancelled"])("409 for a %s schedule, unchanged", async (statusValue) => {
    const row = aliceRow({ status: statusValue, activeDraftId: null });
    expect((await cancel(row.id)).status).toBe(409);
    expect(db.scheduled.get(row.id)!.status).toBe(statusValue);
  });
});

describe("cross-user isolation", () => {
  let row: ReturnType<typeof aliceRow>;

  beforeEach(() => {
    // Bob is connected to the very same shop id — ownership still has to hold.
    row = aliceRow();
    signInAs("bob", "shop-a");
  });

  test("another user's list never includes them", async () => {
    expect(await listRange(FORTNIGHT.from, FORTNIGHT.to)).toEqual([]);
    expect((await list({ draftId: "draft-alice" })).body.scheduledListings).toEqual([]);
  });

  test("another user can't reschedule or cancel them — 404, row untouched", async () => {
    expect((await reschedule(row.id, { date: "2026-09-25", time: "09:00", timezone: "UTC" })).status).toBe(404);
    expect((await cancel(row.id)).status).toBe(404);
    expect(db.scheduled.get(row.id)).toMatchObject({ status: "pending", timezone: "UTC" });
  });

  test("another user can't schedule someone else's draft, even with images uploaded", async () => {
    upload("bob", SET_B, 3);
    const { status } = await create(body({ renderSetId: SET_B }));
    expect(status).toBe(404);
    expect(db.scheduled.size).toBe(1);
  });

  test("images are looked up under the caller's own prefix — someone else's uploads don't count", async () => {
    upload("alice", SET_B, 3);
    seedDraft({ id: "draft-bob-2", userId: "bob" });
    const { status, body: b } = await create(body({ draftId: "draft-bob-2", renderSetId: SET_B }));
    expect(status).toBe(400);
    expect(b.error).toMatch(/didn't finish uploading/);
  });

  test("the owner's own schedule in a shop that isn't active is out of reach too", async () => {
    signInAs("alice", "shop-other");
    expect(await listRange(FORTNIGHT.from, FORTNIGHT.to)).toEqual([]);
    expect((await cancel(row.id)).status).toBe(404);
    signInAs("alice", "shop-a");
    expect((await listRange(FORTNIGHT.from, FORTNIGHT.to)).map((r) => r.id)).toEqual([row.id]);
  });
});
