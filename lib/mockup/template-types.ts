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
  /** "library" (curated, public/templates/) or "user" (uploaded, R2). */
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
  /** Where to fetch the raw image bytes from — `/templates/...` for library, an API route for user uploads. */
  imageUrl: string;
}
