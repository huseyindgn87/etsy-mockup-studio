import { describe, expect, it } from "vitest";
import { MAX_ALT_TEXT_LENGTH } from "@/lib/etsy/listing-image-limits";
import { coercePhotosData } from "@/lib/drafts/validate";
import {
  moveItem,
  publishImageOrder,
  reconcileImageOrder,
  withAltText,
  type ImageSlotRef,
} from "../photo-order";

const own = (id: string): ImageSlotRef => ({ kind: "own", id });
const job = (key: string): ImageSlotRef => ({ kind: "job", key });
const etsy = (imageId: number): ImageSlotRef => ({ kind: "etsy", imageId });

describe("moveItem", () => {
  const ten = Array.from({ length: 10 }, (_, i) => i + 1);

  it("moves the first item to the last position", () => {
    expect(moveItem(ten, 0, 9)).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 1]);
  });

  it("moves the last item into the middle", () => {
    expect(moveItem(ten, 9, 4)).toEqual([1, 2, 3, 4, 10, 5, 6, 7, 8, 9]);
  });

  it("returns the same array for a no-op or out-of-range move", () => {
    expect(moveItem(ten, 3, 3)).toBe(ten);
    expect(moveItem(ten, -1, 3)).toBe(ten);
    expect(moveItem(ten, 0, 10)).toBe(ten);
  });

  it("moves a video into an empty slot", () => {
    expect(moveItem(["a.mp4", null], 0, 1)).toEqual([null, "a.mp4"]);
  });
});

describe("reconcileImageOrder", () => {
  it("keeps a manual order and appends new items", () => {
    const prev = [own("o1"), job("m1::d1")];
    expect(reconcileImageOrder(prev, ["m1::d1", "m2::d1"], ["o1"], new Set())).toEqual([
      own("o1"),
      job("m1::d1"),
      job("m2::d1"),
    ]);
  });

  it("keeps a removed rendered combo out of the grid", () => {
    const prev = [job("m1::d1"), job("m2::d1")];
    expect(reconcileImageOrder(prev, ["m1::d1", "m2::d1"], [], new Set(["m1::d1"]))).toEqual([job("m2::d1")]);
  });

  it("returns the previous array when nothing changed", () => {
    const prev = [job("m1::d1"), own("o1")];
    expect(reconcileImageOrder(prev, ["m1::d1"], ["o1"], new Set())).toBe(prev);
  });
});

describe("reconcileImageOrder for an existing listing's own photos", () => {
  it("puts the listing's photos first, in rank order, ahead of anything added", () => {
    expect(reconcileImageOrder([own("o1")], [], ["o1"], new Set(), [11, 12])).toEqual([etsy(11), etsy(12), own("o1")]);
  });

  it("keeps a restored order while the listing's photos are still loading", () => {
    const restored = [etsy(12), own("o1"), etsy(11)];
    expect(reconcileImageOrder(restored, [], ["o1"], new Set(), null)).toBe(restored);
    expect(reconcileImageOrder(restored, [], ["o1"], new Set(), [11, 12])).toBe(restored);
  });

  it("keeps a removed photo out and drops one Etsy no longer has", () => {
    expect(reconcileImageOrder([etsy(11), etsy(12), etsy(13)], [], [], new Set(), [11, 12], new Set([11]))).toEqual([
      etsy(12),
    ]);
  });

  it("appends a photo that appeared on Etsy after the grid was reordered", () => {
    expect(reconcileImageOrder([etsy(12), etsy(11)], [], [], new Set(), [11, 12, 13])).toEqual([
      etsy(12),
      etsy(11),
      etsy(13),
    ]);
  });
});

describe("publishImageOrder", () => {
  it("sends the listing's own photos by id with their alt text, in grid order", () => {
    const grid = moveItem([etsy(11), etsy(12), own("o1")], 2, 0);
    expect(publishImageOrder(grid, [], [], ["o1"], { "etsy:12": "Side view", "own:o1": "ignored here" })).toEqual([
      { kind: "own", index: 0 },
      { kind: "etsy", imageId: 11, altText: "" },
      { kind: "etsy", imageId: 12, altText: "Side view" },
    ]);
  });

  it("sends the reordered grid as the Etsy upload order", () => {
    const grid = [job("m1::d1"), own("o1"), job("m2::d1"), job("m1::d2")];
    const reordered = moveItem(grid, 0, grid.length - 1);
    expect(publishImageOrder(reordered, ["m1", "m2"], ["d1", "d2"], ["o1"])).toEqual([
      { kind: "own", index: 0 },
      { kind: "job", index: 2 },
      { kind: "job", index: 1 },
      { kind: "job", index: 0 },
    ]);
  });

  it("drops refs to things that no longer exist", () => {
    expect(publishImageOrder([job("gone::d1"), own("gone")], ["m1"], ["d1"], [])).toEqual([]);
  });
});

describe("draft persistence", () => {
  it("round-trips the grid order, removed combos and alt text through a saved draft", () => {
    const imageOrder = moveItem([own("o1"), job("m1::d1"), job("m1::d2")], 2, 0);
    const saved = JSON.parse(
      JSON.stringify({
        imageOrder,
        removedJobKeys: ["m2::d1"],
        altTextBySlot: withAltText({}, "own:o1", "Front view"),
      }),
    );
    const restored = coercePhotosData(saved);
    expect(restored.imageOrder).toEqual([job("m1::d2"), own("o1"), job("m1::d1")]);
    expect(restored.removedJobKeys).toEqual(["m2::d1"]);
    expect(restored.altTextBySlot).toEqual({ "own:o1": "Front view" });
  });

  it("round-trips an existing listing's reordered, removed and alt-texted photos", () => {
    const saved = JSON.parse(
      JSON.stringify({
        imageOrder: [etsy(13), etsy(11)],
        removedEtsyImageIds: [12],
        altTextBySlot: withAltText({}, "etsy:13", "Back view"),
      }),
    );
    const restored = coercePhotosData(saved);
    expect(restored.imageOrder).toEqual([etsy(13), etsy(11)]);
    expect(restored.removedEtsyImageIds).toEqual([12]);
    expect(
      reconcileImageOrder(restored.imageOrder, [], [], new Set(), [11, 12, 13], new Set(restored.removedEtsyImageIds)),
    ).toEqual([etsy(13), etsy(11)]);
  });
});

describe("withAltText", () => {
  it("stores alt text per image without touching the others", () => {
    const first = withAltText({}, "own:o1", "Front view");
    const both = withAltText(first, "job:m1::d1", "Mug on a desk");
    expect(both).toEqual({ "own:o1": "Front view", "job:m1::d1": "Mug on a desk" });
    expect(withAltText(both, "own:o1", "Back view")["job:m1::d1"]).toBe("Mug on a desk");
  });

  it("caps alt text at 500 characters", () => {
    expect(MAX_ALT_TEXT_LENGTH).toBe(500);
    expect(withAltText({}, "own:o1", "x".repeat(650))["own:o1"]).toHaveLength(500);
  });
});
