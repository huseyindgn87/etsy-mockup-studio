import { beforeEach, describe, expect, test, vi } from "vitest";

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
const objects = new Map<string, { body: Buffer; contentType: string }>();

vi.mock("@/lib/drafts/store", () => ({
  getDraftRow: vi.fn(async (userId: string, id: string) => {
    const row = rows.get(id);
    return row && row.userId === userId ? row : null;
  }),
  saveDraft: vi.fn(async (userId: string, id: string, patch: Partial<Row>) => {
    const row = rows.get(id);
    if (!row || row.userId !== userId) return null;
    // Stored as JSON, like the Postgres column.
    Object.assign(row, JSON.parse(JSON.stringify(patch)), { updatedAt: new Date() });
    return row;
  }),
  deleteDraft: vi.fn(async () => true),
}));

vi.mock("@/lib/storage/r2", () => ({
  draftAssetKey: (draftId: string, kind: string, itemId: string) => `drafts/${draftId}/${kind}/${itemId}`,
  draftPrefix: (draftId: string) => `drafts/${draftId}/`,
  listKeys: async (prefix: string) => [...objects.keys()].filter((k) => k.startsWith(prefix)),
  putObject: async (key: string, body: Buffer, contentType: string) => {
    objects.set(key, { body, contentType });
  },
  getObject: async (key: string) => objects.get(key) ?? null,
}));

import { GET as getDraft, PUT as putDraft } from "@/app/api/drafts/[id]/route";
import { GET as getAsset, PUT as putAsset } from "@/app/api/drafts/[id]/assets/[kind]/[itemId]/route";
import { draftVideoSlots, editorVideoSlots, type EditorVideoSlot } from "@/lib/drafts/videos";

const base = "http://localhost";

async function uploadVideo(draftId: string, id: string, file: File) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const res = await putAsset(
    new Request(`${base}/api/drafts/${draftId}/assets/video/${id}`, {
      method: "PUT",
      headers: { "Content-Type": file.type, "Content-Length": String(bytes.byteLength) },
      body: bytes,
    }),
    { params: Promise.resolve({ id: draftId, kind: "video", itemId: id }) },
  );
  expect(res.status).toBe(200);
}

beforeEach(() => {
  rows.clear();
  objects.clear();
  authMock.mockResolvedValue({ user: { id: "u1", email: "seller@example.com" } });
  rows.set("d1", {
    id: "d1",
    userId: "u1",
    title: "",
    formData: {},
    photosData: {},
    hasThumbnail: false,
    sourceMode: null,
    sourceListingId: null,
    updatedAt: new Date(),
  });
});

describe("videos saved with a draft", () => {
  test("come back in the same slots and order after a save, close and reopen", async () => {
    const second = new File([new Uint8Array([2, 2, 2])], "second.mp4", { type: "video/mp4" });
    const first = new File([new Uint8Array([1, 1, 1, 1])], "first.mov", { type: "video/quicktime" });
    // The user moved "second.mp4" into slot 1.
    const editorSlots: EditorVideoSlot[] = [
      { kind: "file", id: "vid-b", file: second },
      { kind: "file", id: "vid-a", file: first },
    ];

    await uploadVideo("d1", "vid-b", second);
    await uploadVideo("d1", "vid-a", first);
    const uploaded = new Set(["vid-a", "vid-b"]);
    const save = await putDraft(
      new Request(`${base}/api/drafts/d1`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ photosData: { videos: draftVideoSlots(editorSlots, (id) => uploaded.has(id)) } }),
      }),
      { params: Promise.resolve({ id: "d1" }) },
    );
    expect(save.status).toBe(200);

    // Reopen: the restore payload, then each stored file fetched from its URL.
    const body = await (await getDraft(new Request(`${base}/api/drafts/d1`), { params: Promise.resolve({ id: "d1" }) })).json();
    const restored = await editorVideoSlots(body.videos, async (url, name) => {
      const [, , , draftId, , kind, itemId] = url.split("/");
      const res = await getAsset(new Request(`${base}${url}`), {
        params: Promise.resolve({ id: draftId, kind, itemId }),
      });
      if (!res.ok) return null;
      const blob = await res.blob();
      return new File([blob], name, { type: blob.type });
    });

    expect(restored.map((v) => (v?.kind === "file" ? [v.id, v.file.name, v.file.type] : v))).toEqual([
      ["vid-b", "second.mp4", "video/mp4"],
      ["vid-a", "first.mov", "video/quicktime"],
    ]);
    const bytes = await Promise.all(
      restored.map(async (v) => (v?.kind === "file" ? [...new Uint8Array(await v.file.arrayBuffer())] : null)),
    );
    expect(bytes).toEqual([
      [2, 2, 2],
      [1, 1, 1, 1],
    ]);
  });

  test("an Etsy video and an empty slot keep their positions", async () => {
    const etsy = { kind: "etsy" as const, videoId: 55, videoUrl: "https://v/55.mp4", thumbnailUrl: "https://v/55.jpg" };
    await putDraft(
      new Request(`${base}/api/drafts/d1`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ photosData: { videos: draftVideoSlots([null, etsy], () => false) } }),
      }),
      { params: Promise.resolve({ id: "d1" }) },
    );
    const body = await (await getDraft(new Request(`${base}/api/drafts/d1`), { params: Promise.resolve({ id: "d1" }) })).json();
    expect(await editorVideoSlots(body.videos, async () => null)).toEqual([null, etsy]);
  });

  test("a picked video still uploading is saved as an empty slot, never a missing file", () => {
    const file = new File([new Uint8Array([1])], "a.mp4", { type: "video/mp4" });
    expect(draftVideoSlots([{ kind: "file", id: "v1", file }], () => false)).toEqual([null]);
  });

  test("a draft saved before videos were kept reports no stored videos", async () => {
    const body = await (await getDraft(new Request(`${base}/api/drafts/d1`), { params: Promise.resolve({ id: "d1" }) })).json();
    expect(body.videos).toBeNull();
  });

  test("an upload cut short on the way in is refused rather than stored", async () => {
    const res = await putAsset(
      new Request(`${base}/api/drafts/d1/assets/video/v1`, {
        method: "PUT",
        headers: { "Content-Type": "video/mp4", "Content-Length": "10" },
        body: new Uint8Array([1, 2, 3]),
      }),
      { params: Promise.resolve({ id: "d1", kind: "video", itemId: "v1" }) },
    );
    expect(res.status).toBe(413);
    expect(objects.size).toBe(0);
  });
});
