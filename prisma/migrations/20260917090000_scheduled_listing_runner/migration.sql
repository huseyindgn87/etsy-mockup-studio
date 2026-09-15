-- AlterTable
ALTER TABLE "scheduled_listings" DROP COLUMN "listingId",
ADD COLUMN     "activeDraftId" TEXT,
ADD COLUMN     "images" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN     "nextAttemptAt" TIMESTAMP(3),
ADD COLUMN     "publishSpec" JSONB,
ADD COLUMN     "renderSetId" TEXT;

-- Backfill (hand-written): a draft may have at most one active schedule.
-- Part 1 only enforced that in application code, so cancel any later
-- duplicates before the unique index is created.
UPDATE "scheduled_listings" s SET "status" = 'cancelled'
WHERE s."status" IN ('pending', 'publishing', 'failed')
  AND s."draftId" IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM "scheduled_listings" o
    WHERE o."draftId" = s."draftId"
      AND o."status" IN ('pending', 'publishing', 'failed')
      AND (o."createdAt" < s."createdAt" OR (o."createdAt" = s."createdAt" AND o."id" < s."id"))
  );

-- Rows scheduled before images were rendered at schedule time have nothing
-- to publish: mark them failed so the user re-schedules from the editor.
UPDATE "scheduled_listings"
SET "status" = 'failed',
    "lastError" = 'Scheduled before images were rendered at schedule time. Open the listing and schedule it again.'
WHERE "status" IN ('pending', 'publishing');

UPDATE "scheduled_listings" SET "activeDraftId" = "draftId"
WHERE "status" IN ('pending', 'publishing', 'failed') AND "draftId" IS NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "scheduled_listings_activeDraftId_key" ON "scheduled_listings"("activeDraftId");

