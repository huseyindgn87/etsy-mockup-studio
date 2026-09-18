import { beforeEach, describe, expect, test, vi } from "vitest";

/**
 * A listing's photos as Etsy behaves (observed on a real listing, 2026-09-18):
 * assigning an attached photo a rank sets that photo's rank without moving any
 * other (ties are possible), deleting the listing's last photo is refused, and
 * a listing holds at most 20 photos. Reads come back in rank order; ties are
 * broken by the higher id first, so a tie never happens to look right.
 */
const etsy = vi.hoisted(() => {
  const state = { photos: [] as { id: number; rank: number; alt: string }[], nextId: 900, calls: [] as string[] };
  return {
    state,
    reset(photos: { id: number; alt?: string }[]) {
      state.photos = photos.map((p, i) => ({ id: p.id, rank: i + 1, alt: p.alt ?? "" }));
      state.nextId = 900;
      state.calls.length = 0;
    },
    order: () => [...state.photos].sort((a, b) => a.rank - b.rank || b.id - a.id),
  };
});
const failing = new Set<string>();

vi.mock("@/lib/etsy/listing-images", () => ({
  assignListingImage: vi.fn(async (p: { listingImageId: number; rank: number; altText?: string }) => {
    etsy.state.calls.push(`rank ${p.listingImageId}@${p.rank}`);
    if (failing.has(`rank ${p.listingImageId}`)) throw new Error("Etsy said no");
    const photo = etsy.state.photos.find((x) => x.id === p.listingImageId);
    if (!photo) throw new Error("not on the listing");
    photo.rank = p.rank;
    if (p.altText) photo.alt = p.altText;
    return { listingImageId: p.listingImageId, rank: p.rank, url: null };
  }),
  deleteListingImage: vi.fn(async (p: { listingImageId: number }) => {
    etsy.state.calls.push(`delete ${p.listingImageId}`);
    if (etsy.state.photos.length === 1) {
      throw new Error("Listings must have at least 1 image. Please add another ListingImage before trying to delete.");
    }
    etsy.state.photos = etsy.state.photos.filter((x) => x.id !== p.listingImageId);
  }),
}));
vi.mock("@/lib/etsy/listing-video", () => ({
  assignListingVideo: vi.fn(async (p: { videoId: number }) => {
    etsy.state.calls.push(`assign video ${p.videoId}`);
  }),
  deleteListingVideo: vi.fn(async (p: { videoId: number }) => {
    etsy.state.calls.push(`delete video ${p.videoId}`);
  }),
}));

import {
  applyListingMediaEdit,
  isEmptyMediaPlan,
  parseMediaOrder,
  planListingMediaEdit,
  type ImagePlacement,
} from "@/lib/etsy/listing-media-edit";

const keep = (imageId: number, altText = ""): ImagePlacement<string> => ({ kind: "existing", imageId, altText });
const added = (item: string, altText = ""): ImagePlacement<string> => ({ kind: "new", item, altText });

/** Photos 1…n, each with alt text "photo N". */
const photos = (n: number) => Array.from({ length: n }, (_, i) => ({ id: i + 1, alt: `photo ${i + 1}` }));
const kept = (...ids: number[]) => ids.map((id) => keep(id, `photo ${id}`));

let fewestPhotos = Infinity;

/** Plans against the simulated listing's current photos, then applies — as the save routes do. */
async function save(images: ImagePlacement<string>[]) {
  const current = { images: etsy.order().map((p) => ({ imageId: p.id, altText: p.alt })), videos: [] };
  const plan = planListingMediaEdit<string, string>(current, { images, videos: null });
  const uploadedIds: Record<string, number> = {};
  const result = await applyListingMediaEdit({
    shopId: 1,
    listingId: 101,
    currentImageCount: current.images.length,
    currentVideoCount: 0,
    plan,
    uploadImage: async (item, rank, altText) => {
      etsy.state.calls.push(`upload ${item}`);
      if (failing.has(`upload ${item}`)) throw new Error("upload failed");
      if (etsy.state.photos.length >= 20) throw new Error("too many photos");
      const id = etsy.state.nextId++;
      etsy.state.photos.push({ id, rank, alt: altText });
      uploadedIds[item] = id;
      return { listingImageId: id, rank, url: null };
    },
    uploadVideo: async () => {},
    imageName: (item) => item,
    videoName: (item) => item,
    readImages: async () => etsy.order().map((p) => ({ imageId: p.id, altText: p.alt })),
  });
  return { plan, result, uploadedIds };
}

const onEtsy = () => etsy.order().map((p) => p.id);
const writes = (kind: "delete" | "upload" | "rank") => etsy.state.calls.filter((c) => c.startsWith(kind));

beforeEach(() => {
  failing.clear();
  fewestPhotos = Infinity;
  etsy.reset(photos(3));
  const original = etsy.state.calls.push.bind(etsy.state.calls);
  etsy.state.calls.push = (...items: string[]) => {
    const n = original(...items);
    fewestPhotos = Math.min(fewestPhotos, etsy.state.photos.length);
    return n;
  };
});

describe("planListingMediaEdit", () => {
  test("an unchanged grid plans nothing", () => {
    const plan = planListingMediaEdit(
      { images: [{ imageId: 1, altText: "front" }, { imageId: 2, altText: "" }], videos: [{ videoId: 71 }] },
      { images: [keep(1, "front"), keep(2)], videos: [{ kind: "existing", videoId: 71 }] },
    );
    expect(isEmptyMediaPlan(plan)).toBe(true);
  });

  test("a reorder deletes nothing and uploads nothing", () => {
    const plan = planListingMediaEdit(
      { images: [{ imageId: 1, altText: "" }, { imageId: 2, altText: "" }, { imageId: 3, altText: "" }], videos: [] },
      { images: [keep(3), keep(1), keep(2)], videos: null },
    );
    expect(plan.deleteImageIds).toEqual([]);
    expect(plan.placeImages).toEqual([]);
    expect(plan.imageOrder).toEqual([keep(3), keep(1), keep(2)]);
  });

  test("only photos the user removed are deleted, only new files are uploaded", () => {
    const plan = planListingMediaEdit(
      { images: [{ imageId: 1, altText: "" }, { imageId: 2, altText: "" }, { imageId: 3, altText: "" }], videos: [] },
      { images: [keep(3), added("new.jpg"), keep(1)], videos: null },
    );
    expect(plan.deleteImageIds).toEqual([2]);
    expect(plan.placeImages).toEqual([added("new.jpg")]);
  });

  test("refuses ids that aren't on the listing, and duplicates", () => {
    const plan = planListingMediaEdit(
      { images: [{ imageId: 1, altText: "front" }, { imageId: 2, altText: "" }], videos: [{ videoId: 71 }] },
      {
        images: [keep(1, "front"), keep(1, "front"), keep(42), keep(2)],
        videos: [{ kind: "existing", videoId: 99 }, { kind: "existing", videoId: 71 }],
      },
    );
    expect(plan.refused).toHaveLength(3);
    expect(isEmptyMediaPlan(plan)).toBe(true);
  });

  test("videos null leaves the listing's videos alone", () => {
    const plan = planListingMediaEdit(
      { images: [{ imageId: 1, altText: "" }], videos: [{ videoId: 71 }] },
      { images: [keep(1)], videos: null },
    );
    expect(plan.deleteVideoIds).toEqual([]);
  });
});

describe("applyListingMediaEdit against Etsy's behaviour", () => {
  test("a reorder only re-ranks: no delete and no upload calls", async () => {
    const { result } = await save(kept(2, 3, 1));
    expect(writes("delete")).toEqual([]);
    expect(writes("upload")).toEqual([]);
    expect(writes("rank")).toEqual(["rank 2@1", "rank 3@2", "rank 1@3"]);
    expect(onEtsy()).toEqual([2, 3, 1]);
    expect(result.failed).toEqual([]);
  });

  test("moving photo 3 to position 1 on a 19-photo listing makes it the thumbnail", async () => {
    etsy.reset(photos(19));
    const order = [3, 1, 2, ...Array.from({ length: 16 }, (_, i) => i + 4)];
    const { result } = await save(kept(...order));
    expect(onEtsy()[0]).toBe(3);
    expect(onEtsy()).toEqual(order);
    expect(etsy.order().map((p) => p.rank)).toEqual(order.map((_, i) => i + 1));
    expect(writes("delete")).toEqual([]);
    expect(writes("upload")).toEqual([]);
    expect(result.failed).toEqual([]);
  });

  test("alt text travels with the re-rank and the photo keeps its id", async () => {
    await save([keep(1, "photo 1"), keep(2, "back of the tee"), keep(3, "photo 3")]);
    expect(etsy.order().map((p) => [p.id, p.alt])).toEqual([
      [1, "photo 1"],
      [2, "back of the tee"],
      [3, "photo 3"],
    ]);
    expect(writes("delete")).toEqual([]);
  });

  test("removing every photo and adding one never leaves the listing empty", async () => {
    const { result, uploadedIds } = await save([added("new.jpg")]);
    expect(etsy.state.calls[0]).toBe("upload new.jpg");
    expect(fewestPhotos).toBeGreaterThan(0);
    expect(onEtsy()).toEqual([uploadedIds["new.jpg"]]);
    expect(result.failed).toEqual([]);
  });

  test("a full listing: removals make room before the new photos that don't fit yet, never reaching zero", async () => {
    etsy.reset(photos(20));
    const { result, uploadedIds } = await save([added("a.jpg"), added("b.jpg"), ...kept(20)]);
    expect(fewestPhotos).toBeGreaterThan(0);
    expect(onEtsy()).toEqual([uploadedIds["a.jpg"], uploadedIds["b.jpg"], 20]);
    expect(writes("delete")).toHaveLength(19);
    expect(result.failed).toEqual([]);
  });

  test("the final order on Etsy equals the editor's order, whatever the mix of moves, adds and removals", async () => {
    const cases: ImagePlacement<string>[][] = [
      [added("x.jpg"), ...kept(3, 1)],
      [...kept(2), added("x.jpg"), ...kept(1), added("y.jpg")],
      kept(3),
      [...kept(1, 2, 3), added("x.jpg")],
    ];
    for (const images of cases) {
      etsy.reset(photos(3));
      const { result, uploadedIds } = await save(images);
      const expected = images.map((e) => (e.kind === "existing" ? e.imageId : uploadedIds[e.item]));
      expect(onEtsy()).toEqual(expected);
      expect(fewestPhotos).toBeGreaterThan(0);
      expect(result.failed).toEqual([]);
    }
  });

  test("a photo Etsy won't delete is reported and kept last; the rest are in the editor's order", async () => {
    etsy.reset(photos(3));
    const deleteListingImage = (await import("@/lib/etsy/listing-images")).deleteListingImage as ReturnType<typeof vi.fn>;
    deleteListingImage.mockImplementationOnce(async () => {
      etsy.state.calls.push("delete 2");
      throw new Error("Etsy said no");
    });
    const { result } = await save(kept(3, 1));
    expect(onEtsy()).toEqual([3, 1, 2]);
    expect(result.failed.map((f) => f.name)).toEqual(["Image 2"]);
  });

  test("a failed upload is reported and the other photos still close up in order", async () => {
    failing.add("upload bad.jpg");
    const { result } = await save([...kept(2), added("bad.jpg"), ...kept(1, 3)]);
    expect(onEtsy()).toEqual([2, 1, 3]);
    expect(result.failed).toEqual([{ name: "bad.jpg", error: "upload failed" }]);
  });

  test("when Etsy doesn't end up in the editor's order, the save says so", async () => {
    failing.add("rank 3");
    const { result } = await save(kept(3, 1, 2));
    expect(result.failed.map((f) => f.name)).toEqual(["Image 3", "Photo order"]);
    expect(result.failed[1].error).toMatch(/Image 3 at position 1/);
  });
});

describe("parseMediaOrder", () => {
  test("keeps well-formed entries and drops the rest", () => {
    expect(
      parseMediaOrder(
        {
          images: [
            { kind: "existing", imageId: 5, altText: "a" },
            { kind: "new", index: 0 },
            { kind: "new", index: 3 },
            { kind: "existing", imageId: -1 },
            "junk",
          ],
          videos: [{ kind: "existing", videoId: 7 }, { kind: "new", index: 1 }],
        },
        1,
        1,
      ),
    ).toEqual({
      images: [
        { kind: "existing", imageId: 5, altText: "a" },
        { kind: "new", item: 0, altText: "" },
      ],
      videos: [{ kind: "existing", videoId: 7 }],
    });
    expect(parseMediaOrder({ images: [] }, 0, 0).videos).toBeNull();
  });
});
