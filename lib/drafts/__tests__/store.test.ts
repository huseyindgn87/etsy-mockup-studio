import { beforeEach, describe, expect, test, vi } from "vitest";

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

/** Per draft id: the statuses and times of its schedules, for `listDrafts`. */
const schedulesByDraft = new Map<string, { status: string; scheduledAt: Date }[]>();
const rows = new Map<string, Row>();
/** The schedules the fake reports for whichever draft is being deleted. */
const scheduledRows: { renderSetId: string | null; images: unknown }[] = [];
let nextId = 1;

vi.mock("@/lib/db/prisma", () => ({
  prisma: {
    listingDraft: {
      create: vi.fn(async ({ data }: { data: Partial<Row> }) => {
        const id = `d${nextId++}`;
        const row: Row = {
          id,
          userId: data.userId as string,
          title: (data.title as string) ?? "",
          formData: data.formData ?? {},
          photosData: data.photosData ?? {},
          hasThumbnail: false,
          sourceMode: null,
          sourceListingId: null,
          updatedAt: new Date(),
        };
        rows.set(id, row);
        return { id };
      }),
      findMany: vi.fn(async ({ where }: { where: { userId: string } }) =>
        [...rows.values()]
          .filter((r) => r.userId === where.userId)
          .filter((r) => !(schedulesByDraft.get(r.id) ?? []).some((s) => s.status === "published"))
          .map((r) => ({
            ...r,
            scheduledListings: (schedulesByDraft.get(r.id) ?? [])
              .filter((s) => s.status === "pending" || s.status === "publishing")
              .sort((a, b) => a.scheduledAt.getTime() - b.scheduledAt.getTime())
              .slice(0, 1),
          })),
      ),
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => rows.get(where.id) ?? null),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Partial<Row> }) => {
        const row = rows.get(where.id)!;
        Object.assign(row, data);
        return row;
      }),
      delete: vi.fn(async ({ where }: { where: { id: string } }) => {
        rows.delete(where.id);
      }),
    },
    scheduledListing: {
      findMany: vi.fn(async () => scheduledRows),
      updateMany: vi.fn(async () => ({ count: 0 })),
    },
  },
}));

vi.mock("@/lib/storage/r2", () => ({
  deletePrefix: vi.fn(async () => {}),
  draftPrefix: (id: string) => `drafts/${id}/`,
  isR2Configured: () => true,
  deleteObjects: vi.fn(async () => {}),
  listKeys: vi.fn(async () => []),
}));

import { SET_A } from "@/lib/scheduling/__tests__/fixtures";
import { renderImageKey } from "@/lib/scheduling/render-keys";
import { createDraft, deleteDraft, getDraftRow, listDrafts, saveDraft } from "../store";

beforeEach(() => {
  rows.clear();
  schedulesByDraft.clear();
  scheduledRows.length = 0;
  nextId = 1;
});

describe("draft ownership isolation", () => {
  test("listDrafts only returns the calling user's own drafts", async () => {
    await createDraft("alice");
    await createDraft("alice");
    await createDraft("bob");

    const aliceDrafts = await listDrafts("alice");
    const bobDrafts = await listDrafts("bob");

    expect(aliceDrafts).toHaveLength(2);
    expect(bobDrafts).toHaveLength(1);
  });

  test("getDraftRow returns null for another user's draft id", async () => {
    const { id } = await createDraft("alice");

    expect(await getDraftRow("alice", id)).not.toBeNull();
    expect(await getDraftRow("bob", id)).toBeNull();
  });

  test("saveDraft refuses to update a draft owned by someone else", async () => {
    const { id } = await createDraft("alice");

    const result = await saveDraft("bob", id, { title: "hijacked" });
    expect(result).toBeNull();

    const stillAlices = await getDraftRow("alice", id);
    expect(stillAlices?.title).toBe("");
  });

  test("deleteDraft refuses to delete a draft owned by someone else", async () => {
    const { id } = await createDraft("alice");

    const ok = await deleteDraft("bob", id);
    expect(ok).toBe(false);
    expect(await getDraftRow("alice", id)).not.toBeNull();
  });
});

describe("listDrafts and scheduling", () => {
  test("filters published drafts in the query and reports a pending schedule's time", async () => {
    const { prisma } = await import("@/lib/db/prisma");
    const plain = await createDraft("alice");
    const pending = await createDraft("alice");
    const published = await createDraft("alice");
    const at = new Date("2026-09-20T15:00:00Z");
    schedulesByDraft.set(pending.id, [{ status: "pending", scheduledAt: at }]);
    schedulesByDraft.set(published.id, [{ status: "published", scheduledAt: at }]);

    const drafts = await listDrafts("alice");
    expect(Object.fromEntries(drafts.map((d) => [d.id, d.scheduledAt]))).toEqual({
      [plain.id]: null,
      [pending.id]: at.toISOString(),
    });
    expect(vi.mocked(prisma.listingDraft.findMany).mock.calls.at(-1)![0]).toMatchObject({
      where: { userId: "alice", scheduledListings: { none: { status: "published" } } },
      select: { scheduledListings: { where: { status: { in: ["pending", "publishing"] } } } },
    });
  });
});

describe("deleteDraft and scheduling", () => {
  test("cancels the draft's still-editable schedules, scoped to its owner, before deleting it", async () => {
    const { prisma } = await import("@/lib/db/prisma");
    const updateMany = vi.mocked(prisma.scheduledListing.updateMany);
    updateMany.mockClear();

    const { id } = await createDraft("alice");
    expect(await deleteDraft("bob", id)).toBe(false);
    expect(updateMany).not.toHaveBeenCalled();

    expect(await deleteDraft("alice", id)).toBe(true);
    expect(updateMany).toHaveBeenCalledWith({
      where: { draftId: id, userId: "alice", status: { in: ["pending", "failed"] } },
      data: { status: "cancelled", activeDraftId: null, renderSetId: null, images: [] },
    });
    expect(await getDraftRow("alice", id)).toBeNull();
  });

  test("deletes the images those schedules had rendered, but never the user's own uploads", async () => {
    const { prisma } = await import("@/lib/db/prisma");
    const { deleteObjects } = await import("@/lib/storage/r2");
    vi.mocked(prisma.scheduledListing.updateMany).mockClear();
    vi.mocked(deleteObjects).mockClear();

    const { id } = await createDraft("alice");
    scheduledRows.push({
      renderSetId: SET_A,
      images: [
        { key: renderImageKey("alice", SET_A, 0), filename: "a.jpg", contentType: "image/jpeg" },
        // A user upload that has no business being here is refused anyway.
        { key: `drafts/${id}/own/photo-1`, filename: "p.jpg", contentType: "image/jpeg" },
      ],
    });

    expect(await deleteDraft("alice", id)).toBe(true);
    expect(deleteObjects).toHaveBeenCalledWith([renderImageKey("alice", SET_A, 0)]);
  });
});
