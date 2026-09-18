import { describe, expect, it } from "vitest";
import { slotIdFor, type ImageSlotRef } from "@/app/components/listing-media/photo-order";
import {
  changedKeys,
  describeUnsynced,
  mediaChanges,
  mediaStateFromEtsy,
  mediaStateFromGrid,
  sameState,
} from "@/lib/etsy/listing-changes";

const ETSY = {
  images: [
    { imageId: 2, rank: 2, altText: "Back" },
    { imageId: 1, rank: 1, altText: "Front" },
  ],
  videos: [{ videoId: 50 }, { videoId: 51 }],
};
const etsyRefs = (...ids: number[]): ImageSlotRef[] => ids.map((imageId) => ({ kind: "etsy", imageId }));
const ALT = { "etsy:1": "Front", "etsy:2": "Back" };
const VIDEOS = [
  { kind: "etsy" as const, videoId: 50 },
  { kind: "etsy" as const, videoId: 51 },
];

const diff = (order: ImageSlotRef[], alt: Record<string, string>, videos: Parameters<typeof mediaStateFromGrid>[2]) =>
  mediaChanges(mediaStateFromEtsy(ETSY), mediaStateFromGrid(order, alt, videos, slotIdFor));

describe("what counts as a change", () => {
  it("deep-equal values are the same whatever their key order; anything else differs", () => {
    expect(sameState({ a: 1, b: [1, 2] }, { b: [1, 2], a: 1 })).toBe(true);
    expect(sameState([1, 2], [2, 1])).toBe(false);
    expect(changedKeys({ a: 1, b: 2, c: 3 }, { a: 1, b: 3, c: 3 })).toEqual(["b"]);
    expect(changedKeys<Record<string, number>>({ a: 1 }, { a: 1, z: 0 })).toEqual(["z"]);
  });

  it("names each unsynced field with its reason", () => {
    expect(describeUnsynced([{ field: "Promote with Etsy Ads", reason: "no endpoint" }])).toBe(
      "Not synced to Etsy: Promote with Etsy Ads (no endpoint).",
    );
  });
});

describe("photo and video grid against Etsy", () => {
  it("the grid as loaded matches", () => {
    expect(diff(etsyRefs(1, 2), ALT, [...VIDEOS, null])).toEqual({ photos: false, videos: false });
  });

  it("reordering photos is a change", () => {
    expect(diff(etsyRefs(2, 1), ALT, VIDEOS)).toEqual({ photos: true, videos: false });
  });

  it("editing alt text is a change", () => {
    expect(diff(etsyRefs(1, 2), { ...ALT, "etsy:2": "Back view" }, VIDEOS).photos).toBe(true);
  });

  it("removing or adding a photo is a change", () => {
    expect(diff(etsyRefs(1), ALT, VIDEOS).photos).toBe(true);
    expect(diff([...etsyRefs(1, 2), { kind: "own", id: "x" }], ALT, VIDEOS).photos).toBe(true);
    expect(diff([...etsyRefs(1, 2), { kind: "job", key: "m::d" }], ALT, VIDEOS).photos).toBe(true);
  });

  it("reordering, removing or adding a video is a change", () => {
    expect(diff(etsyRefs(1, 2), ALT, [VIDEOS[1], VIDEOS[0]])).toEqual({ photos: false, videos: true });
    expect(diff(etsyRefs(1, 2), ALT, [VIDEOS[0], null]).videos).toBe(true);
    const file = new File(["x"], "clip.mp4");
    expect(diff(etsyRefs(1, 2), ALT, [...VIDEOS, { kind: "file", file }]).videos).toBe(true);
  });
});
