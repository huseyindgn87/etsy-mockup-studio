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

describe("publishImageOrder", () => {
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
