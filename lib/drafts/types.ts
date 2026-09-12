/**
 * Shared shapes for the "Save draft" feature (app/api/drafts, lib/drafts/store.ts,
 * app/mockups/page.tsx). Dependency-free like lib/mockup/types.ts, so both
 * server routes and the client editor can import it.
 *
 * The binary files (PSDs, design images, own photos, thumbnail) are never
 * part of this JSON — they live in R2 under a deterministic key per item
 * (see `draftAssetKey` in lib/storage/r2.ts). These types describe only the
 * metadata `photosData` column of `ListingDraft` (prisma/schema.prisma).
 */

import type { Calibration } from "@/lib/mockup/types";

/** One uploaded PSD template, minus the raw bytes (kept in R2, re-parsed on restore). */
export interface DraftMockupMeta {
  id: string;
  name: string;
  /** sha256 of the PSD's bytes — also the mockup-calibration DB key. */
  contentHash: string;
  calibration: Calibration;
  include: boolean;
}

/** One uploaded design image, minus the raw bytes. */
export interface DraftDesignMeta {
  id: string;
  name: string;
}

/** One user-uploaded photo (not a PSD or design), minus the raw bytes. */
export interface DraftOwnImageMeta {
  id: string;
  name: string;
}

/** Matches `ImageSlotRef` in app/mockups/page.tsx. */
export type DraftImageSlotRef = { kind: "job"; key: string } | { kind: "own"; id: string };

/** The editor's photo-grid state — everything except the binary files themselves. */
export interface DraftPhotosData {
  mockups: DraftMockupMeta[];
  designs: DraftDesignMeta[];
  ownImages: DraftOwnImageMeta[];
  imageOrder: DraftImageSlotRef[];
  altTextBySlot: Record<string, string>;
  activeTab: string;
}

export const EMPTY_DRAFT_PHOTOS_DATA: DraftPhotosData = {
  mockups: [],
  designs: [],
  ownImages: [],
  imageOrder: [],
  altTextBySlot: {},
  activeTab: "photos",
};

/**
 * The listing this draft's editor session was seeded from, if any — mirrors
 * `PublishMode`/`TargetListing` in app/mockups/page.tsx. Persisted with the
 * draft row (not just the editor URL's `mode`/`listingId`) so resuming from
 * "My drafts" still knows it's a copy/edit instead of silently falling back
 * to a from-scratch "new" draft and losing the category/shipping borrow a
 * "copy" gets from its source at publish time. Null for a from-scratch draft.
 */
export interface DraftSource {
  mode: "copy" | "existing";
  listingId: number;
}

/** One row of the listings page's "My drafts" filter. */
export interface DraftSummary {
  id: string;
  title: string;
  thumbnailUrl: string | null;
  updatedAt: string;
}

/** The kinds of binary asset a draft can hold, one R2 object per (kind, itemId). */
export type DraftAssetKind = "psd" | "design" | "own" | "thumbnail";
