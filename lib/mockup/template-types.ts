/**
 * Shared shape for the mockup template library — isomorphic (no `fs`, no
 * Prisma), so client components can import it as a type alongside the
 * server-only `template-store.ts`.
 */

import type { Quad } from "./types";

export type TemplateSource = "library" | "user";

export interface TemplateListItem {
  /** The `MockupTemplate` row id. Absent for an uncalibrated library file with no row yet. */
  id: string | null;
  /** "library" (curated, templates/ — outside public/, never served as-is) or "user" (uploaded, R2). */
  source: TemplateSource;
  /** Etsy user id of the uploader, or null for a curated library template. */
  ownerId: string | null;
  filename: string;
  name: string;
  productType: string;
  colour: string;
  dpiHint: number;
  quad: Quad;
  /** Whether this template has a deliberately saved quad (vs. `DEFAULT_QUAD` defaults). */
  calibrated: boolean;
  /**
   * A watermarked, downscaled preview. The unwatermarked file never leaves the
   * server except to an admin (`?raw=1`); renders reference it by {@link TemplateRef}.
   */
  imageUrl: string;
}

/** How a render names a template whose raw bytes only the server reads. */
export type TemplateRef = { source: "library"; filename: string } | { source: "user"; id: string };

/** Response headers on a template preview carrying the original image's size. */
export const TEMPLATE_WIDTH_HEADER = "X-Template-Width";
export const TEMPLATE_HEIGHT_HEADER = "X-Template-Height";

export function templateRefOf(t: Pick<TemplateListItem, "source" | "filename" | "id">): TemplateRef | null {
  if (t.source === "library") return { source: "library", filename: t.filename };
  return t.id ? { source: "user", id: t.id } : null;
}

export function parseTemplateRef(raw: unknown): TemplateRef | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (r.source === "library" && typeof r.filename === "string" && r.filename) {
    return { source: "library", filename: r.filename };
  }
  if (r.source === "user" && typeof r.id === "string" && r.id) return { source: "user", id: r.id };
  return null;
}
