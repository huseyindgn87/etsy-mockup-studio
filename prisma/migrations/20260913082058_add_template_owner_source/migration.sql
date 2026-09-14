-- AlterTable
ALTER TABLE "mockup_templates" ADD COLUMN     "calibrated" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "ownerId" TEXT,
ADD COLUMN     "source" TEXT NOT NULL DEFAULT 'library';

-- CreateIndex
CREATE INDEX "mockup_templates_ownerId_idx" ON "mockup_templates"("ownerId");

-- Every pre-existing row only exists because someone saved a deliberate quad
-- via /admin/templates (see template-store.ts's old "row exists" convention)
-- — backfill them as calibrated so this column's meaning doesn't regress them.
UPDATE "mockup_templates" SET "calibrated" = true;
