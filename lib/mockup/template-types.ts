/**
 * Shared shape for the curated template library — isomorphic (no `fs`, no
 * Prisma), so the admin client component can import it as a type alongside
 * the server-only `template-store.ts`.
 */

import type { Quad } from "./types";

export interface TemplateListItem {
  filename: string;
  name: string;
  productType: string;
  colour: string;
  dpiHint: number;
  quad: Quad;
  /** Whether this template has a saved `MockupTemplate` row (vs. `DEFAULT_QUAD` defaults). */
  calibrated: boolean;
}
