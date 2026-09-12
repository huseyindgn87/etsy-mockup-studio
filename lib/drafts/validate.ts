/**
 * Coercion for a draft's stored `photosData` JSON — untrusted (it round-trips
 * through the DB) but never expected to be genuinely malformed since only our
 * own routes ever write it. Falls back to empty rather than throwing, same
 * spirit as lib/mockup/validate.ts's `coerceCalibration`.
 */

import type { DraftDesignMeta, DraftMockupMeta, DraftOwnImageMeta, DraftPhotosData } from "./types";

export function coercePhotosData(raw: unknown): DraftPhotosData {
  const r = (raw ?? {}) as Partial<DraftPhotosData>;
  return {
    mockups: Array.isArray(r.mockups) ? (r.mockups as DraftMockupMeta[]) : [],
    designs: Array.isArray(r.designs) ? (r.designs as DraftDesignMeta[]) : [],
    ownImages: Array.isArray(r.ownImages) ? (r.ownImages as DraftOwnImageMeta[]) : [],
    imageOrder: Array.isArray(r.imageOrder) ? r.imageOrder : [],
    altTextBySlot:
      r.altTextBySlot && typeof r.altTextBySlot === "object" ? r.altTextBySlot : {},
    activeTab: typeof r.activeTab === "string" ? r.activeTab : "photos",
  };
}
