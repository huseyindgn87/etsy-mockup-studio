/**
 * A **scheduled bulk edit**: the per-listing changes the bulk editor is
 * holding, serialised so the runner can apply them later through the same
 * write path Sync updates uses (`lib/etsy/bulk-apply.ts` and the media save).
 *
 * Pure and dependency-light — the bulk screen builds this payload, the
 * scheduling API validates it, and the runner reads it back out of the row's
 * `bulkEdit` JSON. Nothing here talks to Etsy, Prisma or storage.
 *
 * A row's photo/video grid is stored as the same `{ images, videos }` order
 * `POST /api/etsy/listings/[id]/media` takes, with files it adds replaced by
 * the R2 keys they were copied to at schedule time. Storage can be missing at
 * run time (see AGENTS.md — the bucket isn't provisioned), so media is a
 * separate, independently failing step: a listing's field edits still apply.
 */

import { parseBulkUpdates, type BulkListingPatch } from "@/lib/etsy/bulk-edit";
import { MAX_ALT_TEXT_LENGTH, MAX_LISTING_IMAGES } from "@/lib/etsy/listing-image-limits";
import { MAX_LISTING_VIDEOS } from "@/lib/etsy/video-limits";
import { isOwnedScheduleKey } from "./render-keys";
import type { ScheduledBulkResult } from "./types";

/** One file a scheduled media edit uploads, as stored when the edit was scheduled. */
export interface ScheduledBulkFile {
  /** `scheduled/{userId}/{setId}/media-{listingId}-image-NN`, see render-keys.ts. */
  key: string;
  filename: string;
  contentType: string;
}

export type ScheduledImageEntry =
  | { kind: "existing"; imageId: number; altText: string }
  | { kind: "new"; index: number; altText: string };
export type ScheduledVideoEntry = { kind: "existing"; videoId: number } | { kind: "new"; index: number };

/** One listing's photo/video grid as it should look after the edit runs. */
export interface ScheduledBulkMedia {
  images: ScheduledImageEntry[];
  videos: ScheduledVideoEntry[];
  imageFiles: ScheduledBulkFile[];
  videoFiles: ScheduledBulkFile[];
}

export interface ScheduledBulkUpdate {
  listingId: number;
  /** The listing's title when it was scheduled — what a per-listing result is reported against. */
  title: string;
  patch: BulkListingPatch;
  media?: ScheduledBulkMedia;
}

export interface ScheduledBulkEdit {
  updates: ScheduledBulkUpdate[];
}

export type { ScheduledBulkResult };

export type ParsedBulkEdit = { ok: true; job: ScheduledBulkEdit } | { ok: false; error: string };

/** The most listings one scheduled job may cover — the same cap a save has. */
export const MAX_SCHEDULED_BULK_LISTINGS = 200;
const MAX_JOB_JSON_LENGTH = 2 * 1024 * 1024;
const MAX_TITLE_LENGTH = 200;

function parseFiles(raw: unknown, owns: (key: unknown) => boolean, max: number): ScheduledBulkFile[] | null {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > max) return null;
  const files: ScheduledBulkFile[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") return null;
    const { key, filename, contentType } = entry as Record<string, unknown>;
    if (!owns(key)) return null;
    if (typeof filename !== "string" || typeof contentType !== "string") return null;
    files.push({ key: key as string, filename: filename.slice(0, 255), contentType });
  }
  return files;
}

function parseMedia(raw: unknown, owns: (key: unknown) => boolean): ScheduledBulkMedia | null | "invalid" {
  if (raw == null) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) return "invalid";
  const r = raw as Record<string, unknown>;
  const imageFiles = parseFiles(r.imageFiles, owns, MAX_LISTING_IMAGES);
  const videoFiles = parseFiles(r.videoFiles, owns, MAX_LISTING_VIDEOS);
  if (!imageFiles || !videoFiles) return "invalid";

  const isId = (v: unknown): v is number => Number.isInteger(v) && (v as number) > 0;
  const isIndex = (v: unknown, count: number): v is number =>
    Number.isInteger(v) && (v as number) >= 0 && (v as number) < count;

  const images: ScheduledImageEntry[] = [];
  for (const e of Array.isArray(r.images) ? r.images : []) {
    if (!e || typeof e !== "object") return "invalid";
    const entry = e as Record<string, unknown>;
    const altText = typeof entry.altText === "string" ? entry.altText.slice(0, MAX_ALT_TEXT_LENGTH) : "";
    if (entry.kind === "existing" && isId(entry.imageId)) {
      images.push({ kind: "existing", imageId: entry.imageId, altText });
    } else if (entry.kind === "new" && isIndex(entry.index, imageFiles.length)) {
      images.push({ kind: "new", index: entry.index, altText });
    } else {
      return "invalid";
    }
  }
  if (images.length === 0 || images.length > MAX_LISTING_IMAGES) return "invalid";

  const videos: ScheduledVideoEntry[] = [];
  for (const e of Array.isArray(r.videos) ? r.videos : []) {
    if (!e || typeof e !== "object") return "invalid";
    const entry = e as Record<string, unknown>;
    if (entry.kind === "existing" && isId(entry.videoId)) videos.push({ kind: "existing", videoId: entry.videoId });
    else if (entry.kind === "new" && isIndex(entry.index, videoFiles.length)) {
      videos.push({ kind: "new", index: entry.index });
    } else return "invalid";
  }
  if (videos.length > MAX_LISTING_VIDEOS) return "invalid";

  return { images, videos, imageFiles, videoFiles };
}

/**
 * Validates a bulk edit for storage (at schedule time) or for running (the
 * runner re-reads the stored JSON, so a row written by an older version is
 * refused with a message rather than half-applied).
 *
 * `scope` is whose files the media keys must belong to — every key has to sit
 * under that user's own `scheduled/{userId}/{setId}/` prefix, so a stored job
 * can never make the runner read someone else's object.
 */
export function parseScheduledBulkEdit(
  raw: unknown,
  scope: { userId: string; setId: string | null },
): ParsedBulkEdit {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "The scheduled edits are missing." };
  }
  if (JSON.stringify(raw).length > MAX_JOB_JSON_LENGTH) {
    return { ok: false, error: "The scheduled edits are too large." };
  }
  const entries = (raw as { updates?: unknown }).updates;
  if (!Array.isArray(entries) || entries.length === 0) {
    return { ok: false, error: "There are no changes to schedule." };
  }
  if (entries.length > MAX_SCHEDULED_BULK_LISTINGS) {
    return { ok: false, error: `A scheduled edit can cover at most ${MAX_SCHEDULED_BULK_LISTINGS} listings.` };
  }

  const owns = (key: unknown) => isOwnedScheduleKey(key, scope.userId, scope.setId);
  const media = new Map<number, ScheduledBulkMedia>();
  const titles = new Map<number, string>();
  const patchEntries: { listingId: number; patch: unknown }[] = [];

  for (const entry of entries) {
    if (!entry || typeof entry !== "object") return { ok: false, error: "Each edit must be an object." };
    const e = entry as Record<string, unknown>;
    const listingId = e.listingId;
    if (!Number.isInteger(listingId) || (listingId as number) <= 0) {
      return { ok: false, error: "Each edit needs a valid `listingId`." };
    }
    const id = listingId as number;
    if (titles.has(id)) return { ok: false, error: `Listing ${id} appears twice in one scheduled edit.` };
    titles.set(id, typeof e.title === "string" ? e.title.slice(0, MAX_TITLE_LENGTH) : "");

    const parsedMedia = parseMedia(e.media, owns);
    if (parsedMedia === "invalid") {
      return { ok: false, error: `The photo changes for listing ${id} couldn't be scheduled.` };
    }
    if (parsedMedia) media.set(id, parsedMedia);

    const patch = e.patch;
    const hasPatch = !!patch && typeof patch === "object" && Object.keys(patch as object).length > 0;
    if (hasPatch) patchEntries.push({ listingId: id, patch });
    else if (!parsedMedia) return { ok: false, error: `Listing ${id} has nothing to change.` };
  }

  const patches = new Map<number, BulkListingPatch>();
  if (patchEntries.length > 0) {
    const parsed = parseBulkUpdates(patchEntries);
    // Patches that hold nothing Etsy would accept aren't a failure while the
    // job still has media to save — the listing just has no field changes.
    if (!parsed.ok && !(media.size > 0 && parsed.error === "Nothing to save.")) {
      return { ok: false, error: parsed.error };
    }
    if (parsed.ok) for (const update of parsed.value) patches.set(update.listingId, update.patch);
  }

  const updates: ScheduledBulkUpdate[] = [];
  for (const [listingId, title] of titles) {
    const patch = patches.get(listingId) ?? {};
    const rowMedia = media.get(listingId);
    if (Object.keys(patch).length === 0 && !rowMedia) continue;
    updates.push({ listingId, title, patch, ...(rowMedia ? { media: rowMedia } : {}) });
  }
  if (updates.length === 0) return { ok: false, error: "There are no changes to schedule." };
  return { ok: true, job: { updates } };
}

/** Every R2 key a job's media edits reference — what its cleanup deletes. */
export function bulkEditFileKeys(job: ScheduledBulkEdit): string[] {
  return job.updates.flatMap((update) =>
    [...(update.media?.imageFiles ?? []), ...(update.media?.videoFiles ?? [])].map((file) => file.key),
  );
}

export function coerceBulkResults(raw: unknown): ScheduledBulkResult[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const e = entry as Record<string, unknown>;
    if (!Number.isInteger(e.listingId)) return [];
    return [
      {
        listingId: e.listingId as number,
        title: typeof e.title === "string" ? e.title : "",
        ok: e.ok === true,
        ...(e.partial === true ? { partial: true } : {}),
        ...(typeof e.error === "string" ? { error: e.error } : {}),
      },
    ];
  });
}

/**
 * The listings an attempt still has to write: those a previous attempt didn't
 * finish. A listing that landed is never written twice, the way Sync updates
 * unticks the rows that landed and retries only the failures.
 */
export function pendingBulkUpdates(
  job: ScheduledBulkEdit,
  previous: ScheduledBulkResult[],
): ScheduledBulkUpdate[] {
  const done = new Set(previous.filter((r) => r.ok).map((r) => r.listingId));
  return job.updates.filter((update) => !done.has(update.listingId));
}

/** "Updated 1 of 2 listings. 1 failed." — the same sentence the bulk screen shows. */
export function summariseBulkResults(results: ScheduledBulkResult[]): string {
  const saved = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok).length;
  const total = results.length;
  const head = `Updated ${saved} of ${total} listing${total === 1 ? "" : "s"}.`;
  return failed === 0 ? head : `${head} ${failed} failed.`;
}
