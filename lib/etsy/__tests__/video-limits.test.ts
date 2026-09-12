import { describe, expect, test } from "vitest";
import {
  MAX_VIDEO_SIZE_BYTES,
  checkVideoDuration,
  checkVideoFileBasics,
} from "@/lib/etsy/video-limits";

describe("checkVideoFileBasics", () => {
  test("accepts a common format under the size cap", () => {
    expect(checkVideoFileBasics({ name: "clip.mp4", size: 10 * 1024 * 1024 })).toBeNull();
    expect(checkVideoFileBasics({ name: "clip.MOV", size: 1024 })).toBeNull();
  });

  test("rejects an unsupported extension", () => {
    const err = checkVideoFileBasics({ name: "clip.webm", size: 1024 });
    expect(err).toMatch(/webm/i);
    expect(err).toMatch(/MP4/); // names an accepted format
  });

  test("rejects a file with no extension", () => {
    expect(checkVideoFileBasics({ name: "clip", size: 1024 })).toMatch(/Unsupported file type/);
  });

  test("rejects a file over the size cap", () => {
    const err = checkVideoFileBasics({ name: "clip.mp4", size: MAX_VIDEO_SIZE_BYTES + 1 });
    expect(err).toMatch(/100 MB/);
  });

  test("accepts a file exactly at the size cap", () => {
    expect(checkVideoFileBasics({ name: "clip.mp4", size: MAX_VIDEO_SIZE_BYTES })).toBeNull();
  });
});

describe("checkVideoDuration", () => {
  test("accepts durations within Etsy's 3-15s window", () => {
    expect(checkVideoDuration(3)).toBeNull();
    expect(checkVideoDuration(9)).toBeNull();
    expect(checkVideoDuration(15)).toBeNull();
  });

  test("rejects a video shorter than 3s", () => {
    expect(checkVideoDuration(2.5)).toMatch(/3-15 seconds/);
  });

  test("rejects a video longer than 15s", () => {
    expect(checkVideoDuration(20)).toMatch(/3-15 seconds/);
  });

  test("doesn't block an unreadable duration (NaN, 0, negative, Infinity)", () => {
    expect(checkVideoDuration(NaN)).toBeNull();
    expect(checkVideoDuration(0)).toBeNull();
    expect(checkVideoDuration(-1)).toBeNull();
    expect(checkVideoDuration(Infinity)).toBeNull();
  });
});
