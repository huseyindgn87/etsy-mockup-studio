/**
 * A draft's video slots. Slot order is the listing's video order, so the
 * array keeps one entry per slot (up to `MAX_LISTING_VIDEOS`), `null` for an
 * empty one. A video picked in the editor is stored as an R2 asset
 * (`draftAssetKey(draftId, "video", id)`); a video already on the edited Etsy
 * listing is kept by its Etsy id, like `DraftImageSlotRef`'s "etsy" photos.
 */

import { MAX_LISTING_VIDEOS } from "@/lib/etsy/video-limits";

export type DraftVideoSlot =
  | null
  | { kind: "file"; id: string; name: string }
  | { kind: "etsy"; videoId: number; videoUrl: string; thumbnailUrl: string };

/** What the restore route sends back for a slot: a stored file gains the URL its bytes are fetched from. */
export type RestoredDraftVideoSlot =
  | null
  | { kind: "file"; id: string; name: string; url: string }
  | { kind: "etsy"; videoId: number; videoUrl: string; thumbnailUrl: string };

/** Structurally the editor's `ListingVideoItem` — kept here so lib/ doesn't import from app/. */
export type EditorVideoSlot =
  | null
  | { kind: "file"; id?: string; file: File }
  | { kind: "etsy"; videoId: number; videoUrl: string; thumbnailUrl: string };

/** Same rule as the assets route's item ids. */
const VIDEO_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;

function coerceSlot(raw: unknown): DraftVideoSlot {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (r.kind === "file" && typeof r.id === "string" && VIDEO_ID_RE.test(r.id)) {
    return { kind: "file", id: r.id, name: typeof r.name === "string" ? r.name : "video" };
  }
  if (
    r.kind === "etsy" &&
    Number.isInteger(r.videoId) &&
    (r.videoId as number) > 0 &&
    typeof r.videoUrl === "string" &&
    typeof r.thumbnailUrl === "string"
  ) {
    return { kind: "etsy", videoId: r.videoId as number, videoUrl: r.videoUrl, thumbnailUrl: r.thumbnailUrl };
  }
  return null;
}

/** `null` for a draft saved before videos were persisted — "nothing stored", not "no videos". */
export function coerceDraftVideos(raw: unknown): DraftVideoSlot[] | null {
  if (!Array.isArray(raw)) return null;
  return raw.slice(0, MAX_LISTING_VIDEOS).map(coerceSlot);
}

/**
 * The editor's slots as they're saved. A picked file whose upload hasn't
 * finished is saved as an empty slot until it has — the draft never points
 * at bytes that aren't in storage.
 */
export function draftVideoSlots(
  videos: readonly EditorVideoSlot[],
  isUploaded: (id: string) => boolean,
): DraftVideoSlot[] {
  return videos.slice(0, MAX_LISTING_VIDEOS).map((v) => {
    if (!v) return null;
    if (v.kind === "etsy") {
      return { kind: "etsy", videoId: v.videoId, videoUrl: v.videoUrl, thumbnailUrl: v.thumbnailUrl };
    }
    return v.id && isUploaded(v.id) ? { kind: "file", id: v.id, name: v.file.name } : null;
  });
}

export function restoredDraftVideos(draftId: string, slots: readonly DraftVideoSlot[]): RestoredDraftVideoSlot[] {
  return slots.map((s) =>
    s?.kind === "file" ? { ...s, url: `/api/drafts/${draftId}/assets/video/${s.id}` } : s,
  );
}

/**
 * Rebuilds the editor's slots from a restore payload, in the saved order,
 * padded to `MAX_LISTING_VIDEOS`. A stored file that can't be fetched comes
 * back as an empty slot rather than failing the whole restore.
 */
export async function editorVideoSlots(
  slots: readonly RestoredDraftVideoSlot[],
  loadFile: (url: string, name: string) => Promise<File | null>,
): Promise<EditorVideoSlot[]> {
  const out: EditorVideoSlot[] = [];
  for (const s of slots.slice(0, MAX_LISTING_VIDEOS)) {
    if (!s) out.push(null);
    else if (s.kind === "etsy") out.push(s);
    else {
      const file = await loadFile(s.url, s.name);
      out.push(file ? { kind: "file", id: s.id, file } : null);
    }
  }
  while (out.length < MAX_LISTING_VIDEOS) out.push(null);
  return out;
}
