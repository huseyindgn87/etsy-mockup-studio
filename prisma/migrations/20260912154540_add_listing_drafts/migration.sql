-- CreateTable
CREATE TABLE "listing_drafts" (
    "id" TEXT NOT NULL,
    "etsyUserId" TEXT NOT NULL,
    "title" TEXT NOT NULL DEFAULT '',
    "hasThumbnail" BOOLEAN NOT NULL DEFAULT false,
    "formData" JSONB NOT NULL,
    "photosData" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "listing_drafts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "listing_drafts_etsyUserId_updatedAt_idx" ON "listing_drafts"("etsyUserId", "updatedAt");
