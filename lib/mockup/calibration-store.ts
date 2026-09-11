/**
 * DB-backed calibration persistence (Phase 4 of the migration). Server-only —
 * pulls in Prisma; never import from index.ts or a client component.
 *
 * Keyed by (Etsy user id, content hash of the source PSD's bytes) rather than
 * `filename|size` like the original tool, so renaming or re-exporting the same
 * template still finds its saved calibration.
 */

import { prisma } from "@/lib/db/prisma";
import { coerceCalibration } from "@/lib/mockup/validate";
import type { Calibration } from "@/lib/mockup/types";
import type { Prisma } from "@prisma/client";

export async function getSavedCalibration(
  etsyUserId: string,
  contentHash: string,
): Promise<Calibration | null> {
  const row = await prisma.mockupCalibration.findUnique({
    where: { etsyUserId_contentHash: { etsyUserId, contentHash } },
  });
  return row ? coerceCalibration(row.data) : null;
}

/** Validates `calibration` before writing it, and returns the stored (validated) shape. */
export async function saveCalibration(
  etsyUserId: string,
  contentHash: string,
  calibration: unknown,
): Promise<Calibration> {
  const clean = coerceCalibration(calibration);
  const data = clean as unknown as Prisma.InputJsonValue;
  const row = await prisma.mockupCalibration.upsert({
    where: { etsyUserId_contentHash: { etsyUserId, contentHash } },
    create: { etsyUserId, contentHash, data },
    update: { data },
  });
  return coerceCalibration(row.data);
}
