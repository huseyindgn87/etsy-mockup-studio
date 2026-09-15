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

const rows = new Map<string, Row>();
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
        [...rows.values()].filter((r) => r.userId === where.userId),
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
      updateMany: vi.fn(async () => ({ count: 0 })),
    },
  },
}));

vi.mock("@/lib/storage/r2", () => ({
  deletePrefix: vi.fn(async () => {}),
  draftPrefix: (id: string) => `drafts/${id}/`,
}));

import { createDraft, deleteDraft, getDraftRow, listDrafts, saveDraft } from "../store";

beforeEach(() => {
  rows.clear();
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
      data: { status: "cancelled", activeDraftId: null },
    });
    expect(await getDraftRow("alice", id)).toBeNull();
  });
});
