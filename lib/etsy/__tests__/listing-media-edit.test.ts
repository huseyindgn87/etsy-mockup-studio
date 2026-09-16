import { beforeEach, describe, expect, test, vi } from "vitest";

const calls: string[] = [];
const failing = new Set<string>();

vi.mock("@/lib/etsy/listing-images", () => ({
  assignListingImage: vi.fn(async (p: { listingImageId: number; rank: number; altText?: string }) => {
    const call = `assign ${p.listingImageId}@${p.rank}${p.altText ? ` "${p.altText}"` : ""}`;
    calls.push(call);
    if (failing.has(`assign ${p.listingImageId}`)) throw new Error("Etsy said no");
    return { listingImageId: p.listingImageId, rank: p.rank, url: null };
  }),
  deleteListingImage: vi.fn(async (p: { listingImageId: number }) => {
    calls.push(`delete ${p.listingImageId}`);
    if (failing.has(`delete ${p.listingImageId}`)) throw new Error("Etsy said no");
  }),
}));
vi.mock("@/lib/etsy/listing-video", () => ({
  assignListingVideo: vi.fn(async (p: { videoId: number }) => {
    calls.push(`assign video ${p.videoId}`);
  }),
  deleteListingVideo: vi.fn(async (p: { videoId: number }) => {
    calls.push(`delete video ${p.videoId}`);
  }),
}));

import {
  applyListingMediaEdit,
  isEmptyMediaPlan,
  parseMediaOrder,
  planListingMediaEdit,
  type ImagePlacement,
} from "@/lib/etsy/listing-media-edit";

const current = {
  images: [
    { imageId: 1, altText: "front" },
    { imageId: 2, altText: "" },
    { imageId: 3, altText: "" },
  ],
  videos: [{ videoId: 71 }],
};
const keep = (imageId: number, altText = ""): ImagePlacement<string> => ({ kind: "existing", imageId, altText });

async function run(images: ImagePlacement<string>[]) {
  const plan = planListingMediaEdit<string, string>(current, { images, videos: null });
  return applyListingMediaEdit({
    shopId: 1,
    listingId: 101,
    currentImageCount: current.images.length,
    currentVideoCount: current.videos.length,
    plan,
    uploadImage: async (item, rank, altText) => {
      calls.push(`upload ${item}@${rank}${altText ? ` "${altText}"` : ""}`);
      if (failing.has(`upload ${item}`)) throw new Error("upload failed");
      return { listingImageId: 500, rank, url: null };
    },
    uploadVideo: async () => {},
    imageName: (item) => item,
    videoName: (item) => item,
  });
}

beforeEach(() => {
  calls.length = 0;
  failing.clear();
});

describe("planListingMediaEdit", () => {
  test("an unchanged grid plans nothing", () => {
    const plan = planListingMediaEdit(current, {
      images: [keep(1, "front"), keep(2), keep(3)],
      videos: [{ kind: "existing", videoId: 71 }],
    });
    expect(isEmptyMediaPlan(plan)).toBe(true);
  });

  test("keeps the unchanged leading photos and rebuilds from the first difference", () => {
    const plan = planListingMediaEdit(current, { images: [keep(1, "front"), keep(3), keep(2)], videos: null });
    expect(plan.deleteImageIds).toEqual([2, 3]);
    expect(plan.placeImages).toEqual([keep(3), keep(2)]);
  });

  test("an alt text edit counts as a change to that photo only onwards", () => {
    const plan = planListingMediaEdit(current, { images: [keep(1, "front"), keep(2), keep(3, "side")], videos: null });
    expect(plan.deleteImageIds).toEqual([3]);
    expect(plan.placeImages).toEqual([keep(3, "side")]);
  });

  test("refuses ids that aren't on the listing, and duplicates", () => {
    const plan = planListingMediaEdit(current, {
      images: [keep(1, "front"), keep(1, "front"), keep(42), keep(2), keep(3)],
      videos: [{ kind: "existing", videoId: 99 }, { kind: "existing", videoId: 71 }],
    });
    expect(plan.refused).toHaveLength(3);
    expect(isEmptyMediaPlan(plan)).toBe(true);
  });

  test("videos null leaves the listing's videos alone", () => {
    const plan = planListingMediaEdit(current, { images: [keep(1, "front"), keep(2), keep(3)], videos: null });
    expect(plan.deleteVideoIds).toEqual([]);
  });
});

describe("applyListingMediaEdit", () => {
  test("re-places photos at contiguous ranks after the kept prefix", async () => {
    const result = await run([keep(1, "front"), { kind: "new", item: "new.jpg", altText: "close-up" }, keep(3), keep(2)]);
    expect(calls).toEqual(["delete 2", "delete 3", 'upload new.jpg@2 "close-up"', "assign 3@3", "assign 2@4"]);
    expect(result.failed).toEqual([]);
  });

  test("a failed placement is reported and the next photo takes its rank", async () => {
    failing.add("upload bad.jpg");
    const result = await run([keep(1, "front"), { kind: "new", item: "bad.jpg", altText: "" }, keep(2), keep(3)]);
    expect(calls).toEqual(["delete 2", "delete 3", "upload bad.jpg@2", "assign 2@2", "assign 3@3"]);
    expect(result.failed).toEqual([{ name: "bad.jpg", error: "upload failed" }]);
  });

  test("a photo whose delete failed stays put and is not placed twice", async () => {
    failing.add("delete 2");
    const result = await run([keep(3), keep(2), keep(1, "front")]);
    expect(calls).toEqual(["delete 1", "delete 2", "delete 3", "assign 3@2", "assign 1@3 \"front\""]);
    expect(result.failed.map((f) => f.name)).toEqual(["Image 2"]);
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
