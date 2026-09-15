import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// Real routes + real lib/scheduling/store.ts over an in-memory Prisma
// (./fake-prisma.ts). Only the app session and "which Etsy shop is active"
// are mocked.

const { authMock, shopMock } = vi.hoisted(() => ({ authMock: vi.fn(), shopMock: vi.fn() }));
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
vi.mock("@/lib/db/prisma", async () => ({ prisma: (await import("./fake-prisma")).fakePrisma }));

import { GET, POST } from "@/app/api/schedule/route";
import { PATCH } from "@/app/api/schedule/[id]/route";
import { POST as CANCEL } from "@/app/api/schedule/[id]/cancel/route";
import { NotConnectedError } from "@/lib/etsy/listing-store";
import { utcToWallTime } from "@/lib/scheduling/timezone";
import type { ScheduledListingSummary } from "@/lib/scheduling/types";
import { db, resetDb, seedDraft, seedScheduled } from "./fake-prisma";

const NOW = new Date("2026-09-16T12:00:00Z");

/** Which shop each test user currently has active. */
const activeShop: Record<string, string> = {};

function signInAs(userId: string, shopId: string) {
  activeShop[userId] = shopId;
  authMock.mockResolvedValue({ user: { id: userId } });
  shopMock.mockImplementation(async (uid: string) => activeShop[uid]);
}

const json = (body: unknown) => ({
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});
const withId = (id: string) => ({ params: Promise.resolve({ id }) });

async function create(body: unknown) {
  const res = await POST(new Request("http://localhost/api/schedule", { method: "POST", ...json(body) }));
  return { status: res.status, body: await res.json() };
}
async function list(query: Record<string, string>) {
  const { NextRequest } = await import("next/server");
  const res = await GET(new NextRequest(`http://localhost/api/schedule?${new URLSearchParams(query)}`));
  return { status: res.status, body: await res.json() };
}
async function listRange(from: string, to: string): Promise<ScheduledListingSummary[]> {
  const { status, body } = await list({ from, to });
  expect(status).toBe(200);
  return body.scheduledListings;
}
async function reschedule(id: string, body: unknown) {
  const res = await PATCH(
    new Request(`http://localhost/api/schedule/${id}`, { method: "PATCH", ...json(body) }),
    withId(id),
  );
  return { status: res.status, body: await res.json() };
}
async function cancel(id: string) {
  const res = await CANCEL(new Request(`http://localhost/api/schedule/${id}/cancel`, { method: "POST" }), withId(id));
  return { status: res.status, body: await res.json() };
}

const FORTNIGHT = { from: "2026-09-14T00:00:00.000Z", to: "2026-09-28T00:00:00.000Z" };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  resetDb();
  authMock.mockReset();
  shopMock.mockReset();
  signInAs("alice", "shop-a");
  seedDraft({ id: "draft-alice", userId: "alice", title: "Halloween mug", hasThumbnail: true });
  seedDraft({ id: "draft-bob", userId: "bob", title: "Bob's poster" });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("POST /api/schedule — create", () => {
  test("stores the wall time as a UTC instant, keeps the draft a draft, and returns the summary", async () => {
    const { status, body } = await create({
      draftId: "draft-alice",
      date: "2026-09-20",
      time: "14:30",
      timezone: "Europe/Istanbul",
    });
    expect(status).toBe(201);
    expect(body.scheduledListing).toMatchObject({
      draftId: "draft-alice",
      title: "Halloween mug",
      thumbnailUrl: "/api/drafts/draft-alice/assets/thumbnail/thumb",
      scheduledAt: "2026-09-20T11:30:00.000Z",
      timezone: "Europe/Istanbul",
      status: "pending",
      attemptCount: 0,
      lastError: null,
      etsyListingId: null,
    });

    const [row] = [...db.scheduled.values()];
    expect(row).toMatchObject({ userId: "alice", shopId: "shop-a", draftId: "draft-alice" });
    expect(row.scheduledAt.toISOString()).toBe("2026-09-20T11:30:00.000Z");
    // Scheduling never touches the draft itself.
    expect(db.drafts.get("draft-alice")).toMatchObject({ title: "Halloween mug" });
  });

  test("rejects a time in the past and stores nothing", async () => {
    const { status, body } = await create({
      draftId: "draft-alice",
      date: "2026-09-16",
      time: "11:59",
      timezone: "UTC",
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/in the past/);
    expect(db.scheduled.size).toBe(0);
  });

  test("judges the past in the chosen timezone (14:30 Istanbul is already gone at 12:00 UTC)", async () => {
    expect((await create({ draftId: "draft-alice", date: "2026-09-16", time: "14:30", timezone: "Europe/Istanbul" })).status).toBe(400);
    expect((await create({ draftId: "draft-alice", date: "2026-09-16", time: "14:30", timezone: "America/New_York" })).status).toBe(201);
  });

  test.each([
    [{ date: "2026-09-20", time: "14:30", timezone: "UTC" }],
    [{ draftId: "draft-alice", listingId: "123", date: "2026-09-20", time: "14:30", timezone: "UTC" }],
    [{ draftId: "draft-alice", date: "2026-09-20", time: "14:30", timezone: "Nowhere/Town" }],
    [{ draftId: "draft-alice", date: "2026-09-20", timezone: "UTC" }],
  ])("400 for a malformed body %j", async (body) => {
    expect((await create(body)).status).toBe(400);
    expect(db.scheduled.size).toBe(0);
  });

  test("409 when the draft already has a live schedule; allowed again once that one is cancelled", async () => {
    const input = { draftId: "draft-alice", date: "2026-09-20", time: "14:30", timezone: "UTC" };
    const first = await create(input);
    expect(first.status).toBe(201);
    const second = await create({ ...input, time: "16:00" });
    expect(second.status).toBe(409);
    expect(db.scheduled.size).toBe(1);

    expect((await cancel(first.body.scheduledListing.id)).status).toBe(200);
    expect((await create({ ...input, time: "16:00" })).status).toBe(201);
  });

  test("can schedule a listing from the active shop's listings cache, but not another shop's", async () => {
    db.listings.push(
      { id: "l1", userId: "alice", shopId: "shop-a", listingId: "111", title: "Cached mug", thumbnailUrl: "https://i.etsystatic.com/1.jpg", removedAt: null },
      { id: "l2", userId: "alice", shopId: "shop-z", listingId: "222", title: "Other shop", thumbnailUrl: null, removedAt: null },
    );
    const ok = await create({ listingId: "111", date: "2026-09-20", time: "10:00", timezone: "UTC" });
    expect(ok.status).toBe(201);
    expect(ok.body.scheduledListing).toMatchObject({ listingId: "111", draftId: null, title: "Cached mug", thumbnailUrl: "https://i.etsystatic.com/1.jpg" });

    expect((await create({ listingId: "222", date: "2026-09-20", time: "10:00", timezone: "UTC" })).status).toBe(404);
  });

  test("401 when signed out, and when no Etsy shop is connected", async () => {
    authMock.mockResolvedValueOnce(null);
    expect((await create({ draftId: "draft-alice", date: "2026-09-20", time: "14:30", timezone: "UTC" })).status).toBe(401);

    shopMock.mockRejectedValueOnce(new NotConnectedError());
    expect((await create({ draftId: "draft-alice", date: "2026-09-20", time: "14:30", timezone: "UTC" })).status).toBe(401);
    expect(db.scheduled.size).toBe(0);
  });
});

describe("timezone round trip through the API", () => {
  test.each([
    ["Europe/Istanbul", "2026-09-20", "14:30"],
    ["America/Los_Angeles", "2026-11-01", "23:45"],
    ["Asia/Kolkata", "2026-09-17", "00:15"],
    ["Australia/Sydney", "2026-10-04", "03:00"], // first hour after Sydney's DST start
  ])("%s %s %s is stored in UTC and reads back as the same wall time", async (timezone, date, time) => {
    const created = await create({ draftId: "draft-alice", date, time, timezone });
    expect(created.status).toBe(201);
    const summary: ScheduledListingSummary = created.body.scheduledListing;
    expect(summary.scheduledAt.endsWith("Z")).toBe(true);
    expect(summary.timezone).toBe(timezone);
    expect(utcToWallTime(new Date(summary.scheduledAt), timezone)).toEqual({ date, time });
  });
});

describe("GET /api/schedule — range filtering", () => {
  test("returns only rows in [from, to), soonest first, without cancelled ones", async () => {
    const at = (iso: string, extra: object = {}) =>
      seedScheduled({ userId: "alice", shopId: "shop-a", draftId: "draft-alice", scheduledAt: new Date(iso), ...extra });
    at("2026-09-13T23:59:59.999Z"); // just before
    const atStart = at("2026-09-14T00:00:00.000Z"); // inclusive start
    const late = at("2026-09-27T23:59:00.000Z");
    const mid = at("2026-09-20T09:00:00.000Z", { status: "failed", lastError: "Etsy said no" });
    const published = at("2026-09-18T09:00:00.000Z", { status: "published", etsyListingId: "999" });
    at("2026-09-19T09:00:00.000Z", { status: "cancelled" });
    at("2026-09-28T00:00:00.000Z"); // exclusive end
    at("2026-10-05T00:00:00.000Z"); // next fortnight

    const rows = await listRange(FORTNIGHT.from, FORTNIGHT.to);
    expect(rows.map((r) => r.id)).toEqual([atStart.id, published.id, mid.id, late.id]);
    expect(rows.find((r) => r.id === mid.id)).toMatchObject({ status: "failed", lastError: "Etsy said no" });
    expect(rows.find((r) => r.id === published.id)).toMatchObject({ status: "published", etsyListingId: "999" });

    const next = await listRange("2026-09-28T00:00:00.000Z", "2026-10-12T00:00:00.000Z");
    expect(next).toHaveLength(2);
  });

  test("400 for a missing, reversed or oversized range", async () => {
    expect((await list({ from: FORTNIGHT.from })).status).toBe(400);
    expect((await list({ from: FORTNIGHT.to, to: FORTNIGHT.from })).status).toBe(400);
    expect((await list({ from: "2026-01-01T00:00:00Z", to: "2026-12-31T00:00:00Z" })).status).toBe(400);
  });

  test("?draftId= returns just that draft's live schedule", async () => {
    seedScheduled({ userId: "alice", shopId: "shop-a", draftId: "draft-alice", scheduledAt: new Date("2026-09-01T00:00:00Z"), status: "cancelled" });
    const live = seedScheduled({ userId: "alice", shopId: "shop-a", draftId: "draft-alice", scheduledAt: new Date("2026-09-20T00:00:00Z") });
    const { body } = await list({ draftId: "draft-alice" });
    expect(body.scheduledListings.map((r: ScheduledListingSummary) => r.id)).toEqual([live.id]);
  });
});

describe("PATCH /api/schedule/[id] — reschedule", () => {
  test("moves a pending schedule to the new instant and timezone", async () => {
    const row = seedScheduled({ userId: "alice", shopId: "shop-a", draftId: "draft-alice", scheduledAt: new Date("2026-09-20T09:00:00Z") });
    const { status, body } = await reschedule(row.id, { date: "2026-09-25", time: "08:15", timezone: "America/New_York" });
    expect(status).toBe(200);
    expect(body.scheduledListing).toMatchObject({ scheduledAt: "2026-09-25T12:15:00.000Z", timezone: "America/New_York", status: "pending" });
    expect(db.scheduled.get(row.id)!.scheduledAt.toISOString()).toBe("2026-09-25T12:15:00.000Z");
  });

  test("a failed schedule goes back to pending with its attempts and error cleared", async () => {
    const row = seedScheduled({
      userId: "alice", shopId: "shop-a", draftId: "draft-alice",
      scheduledAt: new Date("2026-09-15T09:00:00Z"), status: "failed", attemptCount: 3, lastError: "Etsy 500",
    });
    const { status } = await reschedule(row.id, { date: "2026-09-21", time: "09:00", timezone: "UTC" });
    expect(status).toBe(200);
    expect(db.scheduled.get(row.id)).toMatchObject({ status: "pending", attemptCount: 0, lastError: null });
  });

  test("rejects a past time and leaves the row alone", async () => {
    const row = seedScheduled({ userId: "alice", shopId: "shop-a", draftId: "draft-alice", scheduledAt: new Date("2026-09-20T09:00:00Z") });
    const { status, body } = await reschedule(row.id, { date: "2026-09-10", time: "09:00", timezone: "UTC" });
    expect(status).toBe(400);
    expect(body.error).toMatch(/in the past/);
    expect(db.scheduled.get(row.id)!.scheduledAt.toISOString()).toBe("2026-09-20T09:00:00.000Z");
  });

  test.each(["publishing", "published", "cancelled"])("409 for a %s schedule, unchanged", async (statusValue) => {
    const row = seedScheduled({ userId: "alice", shopId: "shop-a", draftId: "draft-alice", scheduledAt: new Date("2026-09-20T09:00:00Z"), status: statusValue });
    const { status } = await reschedule(row.id, { date: "2026-09-25", time: "09:00", timezone: "UTC" });
    expect(status).toBe(409);
    expect(db.scheduled.get(row.id)).toMatchObject({ status: statusValue });
    expect(db.scheduled.get(row.id)!.scheduledAt.toISOString()).toBe("2026-09-20T09:00:00.000Z");
  });

  test("404 for an id that doesn't exist", async () => {
    expect((await reschedule("nope", { date: "2026-09-25", time: "09:00", timezone: "UTC" })).status).toBe(404);
  });
});

describe("POST /api/schedule/[id]/cancel", () => {
  test("cancels a pending schedule, which then drops off the calendar", async () => {
    const row = seedScheduled({ userId: "alice", shopId: "shop-a", draftId: "draft-alice", scheduledAt: new Date("2026-09-20T09:00:00Z") });
    const { status, body } = await cancel(row.id);
    expect(status).toBe(200);
    expect(body.scheduledListing.status).toBe("cancelled");
    expect(db.scheduled.get(row.id)!.status).toBe("cancelled");
    expect(await listRange(FORTNIGHT.from, FORTNIGHT.to)).toEqual([]);
    // The draft is kept.
    expect(db.drafts.has("draft-alice")).toBe(true);
  });

  test("a failed schedule can be cancelled too", async () => {
    const row = seedScheduled({ userId: "alice", shopId: "shop-a", draftId: "draft-alice", scheduledAt: new Date("2026-09-15T09:00:00Z"), status: "failed" });
    expect((await cancel(row.id)).status).toBe(200);
  });

  test.each(["publishing", "published", "cancelled"])("409 for a %s schedule, unchanged", async (statusValue) => {
    const row = seedScheduled({ userId: "alice", shopId: "shop-a", draftId: "draft-alice", scheduledAt: new Date("2026-09-20T09:00:00Z"), status: statusValue });
    expect((await cancel(row.id)).status).toBe(409);
    expect(db.scheduled.get(row.id)!.status).toBe(statusValue);
  });
});

describe("cross-user isolation", () => {
  let aliceRow: ReturnType<typeof seedScheduled>;

  beforeEach(() => {
    // Bob is connected to the very same shop id — ownership still has to hold.
    aliceRow = seedScheduled({ userId: "alice", shopId: "shop-a", draftId: "draft-alice", scheduledAt: new Date("2026-09-20T09:00:00Z") });
    signInAs("bob", "shop-a");
  });

  test("another user's list never includes them", async () => {
    expect(await listRange(FORTNIGHT.from, FORTNIGHT.to)).toEqual([]);
    expect((await list({ draftId: "draft-alice" })).body.scheduledListings).toEqual([]);
  });

  test("another user can't reschedule them — 404, row untouched", async () => {
    const { status } = await reschedule(aliceRow.id, { date: "2026-09-25", time: "09:00", timezone: "UTC" });
    expect(status).toBe(404);
    expect(db.scheduled.get(aliceRow.id)).toMatchObject({ status: "pending", timezone: "UTC" });
    expect(db.scheduled.get(aliceRow.id)!.scheduledAt.toISOString()).toBe("2026-09-20T09:00:00.000Z");
  });

  test("another user can't cancel them — 404, row untouched", async () => {
    expect((await cancel(aliceRow.id)).status).toBe(404);
    expect(db.scheduled.get(aliceRow.id)!.status).toBe("pending");
  });

  test("another user can't schedule someone else's draft", async () => {
    const { status } = await create({ draftId: "draft-alice", date: "2026-09-25", time: "09:00", timezone: "UTC" });
    expect(status).toBe(404);
    expect(db.scheduled.size).toBe(1);
  });

  test("the owner's own schedule in a shop that isn't active is out of reach too", async () => {
    signInAs("alice", "shop-other");
    expect(await listRange(FORTNIGHT.from, FORTNIGHT.to)).toEqual([]);
    expect((await cancel(aliceRow.id)).status).toBe(404);
    expect((await reschedule(aliceRow.id, { date: "2026-09-25", time: "09:00", timezone: "UTC" })).status).toBe(404);

    signInAs("alice", "shop-a");
    expect((await listRange(FORTNIGHT.from, FORTNIGHT.to)).map((r) => r.id)).toEqual([aliceRow.id]);
  });
});
