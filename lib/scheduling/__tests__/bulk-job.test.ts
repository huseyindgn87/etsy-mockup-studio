import { describe, expect, test } from "vitest";

import {
  bulkEditFileKeys,
  coerceBulkResults,
  parseScheduledBulkEdit,
  pendingBulkUpdates,
  summariseBulkResults,
  type ScheduledBulkEdit,
} from "../bulk-job";
import { bulkMediaKey } from "../render-keys";
import { SET_A, SET_B } from "./fixtures";

const scope = { userId: "alice", setId: SET_A };
const imageKey = (listingId: number, index = 0, set = SET_A) =>
  bulkMediaKey("alice", set, listingId, "image", index);

const media = (listingId: number) => ({
  images: [
    { kind: "existing", imageId: 7, altText: "Front" },
    { kind: "new", index: 0, altText: "Back" },
  ],
  videos: [],
  imageFiles: [{ key: imageKey(listingId), filename: "back.jpg", contentType: "image/jpeg" }],
  videoFiles: [],
});

describe("parseScheduledBulkEdit", () => {
  test("keeps each listing's patch, title and media", () => {
    const parsed = parseScheduledBulkEdit(
      {
        updates: [
          { listingId: 101, title: "Mug", patch: { title: "New title", quantity: 4 } },
          { listingId: 102, title: "Tee", patch: {}, media: media(102) },
        ],
      },
      scope,
    );
    expect(parsed).toMatchObject({
      ok: true,
      job: {
        updates: [
          { listingId: 101, title: "Mug", patch: { title: "New title", quantity: 4 } },
          { listingId: 102, title: "Tee", patch: {} },
        ],
      },
    });
    const job = (parsed as { job: ScheduledBulkEdit }).job;
    expect(job.updates[1].media?.imageFiles[0].key).toBe(imageKey(102));
    expect(bulkEditFileKeys(job)).toEqual([imageKey(102)]);
  });

  test("refuses a file key that isn't this job's own storage", () => {
    for (const key of [
      imageKey(101, 0, SET_B),
      "drafts/d1/photo/p1",
      bulkMediaKey("mallory", SET_A, 101, "image", 0),
    ]) {
      const parsed = parseScheduledBulkEdit(
        {
          updates: [{ listingId: 101, title: "Mug", patch: {}, media: { ...media(101), imageFiles: [{ key, filename: "x.jpg", contentType: "image/jpeg" }] } }],
        },
        scope,
      );
      expect(parsed).toEqual({ ok: false, error: "The photo changes for listing 101 couldn't be scheduled." });
    }
  });

  test("refuses an invalid patch, a repeated listing and an empty job", () => {
    expect(parseScheduledBulkEdit({ updates: [] }, scope)).toEqual({
      ok: false,
      error: "There are no changes to schedule.",
    });
    expect(
      parseScheduledBulkEdit(
        { updates: [{ listingId: 101, title: "a", patch: { title: "x" } }, { listingId: 101, title: "a", patch: { title: "y" } }] },
        scope,
      ),
    ).toEqual({ ok: false, error: "Listing 101 appears twice in one scheduled edit." });
    const badPatch = parseScheduledBulkEdit(
      { updates: [{ listingId: 101, title: "a", patch: { quantity: -3 } }] },
      scope,
    );
    expect(badPatch.ok).toBe(false);
    expect(parseScheduledBulkEdit({ updates: [{ listingId: 101, title: "a", patch: {} }] }, scope)).toEqual({
      ok: false,
      error: "Listing 101 has nothing to change.",
    });
  });

  test("a media edit that adds no file needs no storage set", () => {
    const parsed = parseScheduledBulkEdit(
      {
        updates: [
          {
            listingId: 101,
            title: "Mug",
            patch: {},
            media: { images: [{ kind: "existing", imageId: 7, altText: "Front" }], videos: [], imageFiles: [], videoFiles: [] },
          },
        ],
      },
      { userId: "alice", setId: null },
    );
    expect(parsed.ok).toBe(true);
    expect(bulkEditFileKeys((parsed as { job: ScheduledBulkEdit }).job)).toEqual([]);
  });
});

describe("retrying", () => {
  const job: ScheduledBulkEdit = {
    updates: [
      { listingId: 101, title: "Mug", patch: { title: "a" } },
      { listingId: 102, title: "Tee", patch: { title: "b" } },
    ],
  };

  test("only the listings a previous attempt didn't finish are written again", () => {
    const previous = [
      { listingId: 101, title: "Mug", ok: true },
      { listingId: 102, title: "Tee", ok: false, error: "Etsy said no" },
    ];
    expect(pendingBulkUpdates(job, previous).map((u) => u.listingId)).toEqual([102]);
    expect(pendingBulkUpdates(job, []).map((u) => u.listingId)).toEqual([101, 102]);
  });

  test("results survive a round trip through JSON and are summarised like a save", () => {
    const results = [
      { listingId: 101, title: "Mug", ok: true },
      { listingId: 102, title: "Tee", ok: false, partial: true, error: "Variation photos: no" },
    ];
    expect(coerceBulkResults(JSON.parse(JSON.stringify(results)))).toEqual(results);
    expect(coerceBulkResults("nonsense")).toEqual([]);
    expect(summariseBulkResults(results)).toBe("Updated 1 of 2 listings. 1 failed.");
    expect(summariseBulkResults([results[0]])).toBe("Updated 1 of 1 listing.");
  });
});
