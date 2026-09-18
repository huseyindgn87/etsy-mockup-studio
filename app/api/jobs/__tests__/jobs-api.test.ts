import { beforeEach, describe, expect, test, vi } from "vitest";

const { authMock } = vi.hoisted(() => ({ authMock: vi.fn() }));
vi.mock("@/auth", () => ({ auth: authMock }));
vi.mock("@/lib/db/prisma", async () => ({ prisma: (await import("@/lib/jobs/__tests__/fake-jobs-prisma")).fakeJobModels }));

import { GET as GET_JOB } from "@/app/api/jobs/[id]/route";
import { GET as LIST_JOBS } from "@/app/api/jobs/route";
import { resetJobsDb, seedJob } from "@/lib/jobs/__tests__/fake-jobs-prisma";

const T = Date.parse("2026-09-18T12:00:00Z");

beforeEach(() => {
  resetJobsDb(() => new Date(T));
  authMock.mockResolvedValue({ user: { id: "alice" } });
});

const get = (id: string) => GET_JOB(new Request(`http://localhost/api/jobs/${id}`), { params: Promise.resolve({ id }) });

describe("GET /api/jobs/[id]", () => {
  test("the owner sees where the job stands", async () => {
    seedJob({ id: "other", userId: "bob", type: "bulk_save", priority: 0, createdAt: new Date(T - 60_000) });
    seedJob({ id: "mine", userId: "alice", type: "bulk_save", priority: 0 });
    const res = await get("mine");
    expect(res.status).toBe(200);
    expect((await res.json()).job).toMatchObject({ id: "mine", status: "queued", position: 2 });
  });

  test("another user's job is not found, and signed-out callers are refused", async () => {
    seedJob({ id: "bobs", userId: "bob", type: "bulk_save", priority: 0 });
    expect((await get("bobs")).status).toBe(404);
    authMock.mockResolvedValue(null);
    expect((await get("bobs")).status).toBe(401);
  });

  test("a failed job carries its reason", async () => {
    seedJob({ id: "f", userId: "alice", type: "bulk_save", priority: 0, status: "failed", error: "Listing not found." });
    expect((await (await get("f")).json()).job).toMatchObject({ status: "failed", error: "Listing not found.", position: null });
  });
});

describe("GET /api/jobs", () => {
  test("lists only the caller's jobs, newest first", async () => {
    seedJob({ id: "a1", userId: "alice", type: "bulk_save", priority: 0, createdAt: new Date(T - 2000) });
    seedJob({ id: "b1", userId: "bob", type: "bulk_save", priority: 0 });
    seedJob({ id: "a2", userId: "alice", type: "listing_refresh", priority: 0, createdAt: new Date(T - 1000) });
    const body = await (await LIST_JOBS()).json();
    expect(body.jobs.map((j: { id: string }) => j.id)).toEqual(["a2", "a1"]);
  });
});
