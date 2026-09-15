-- CreateTable
CREATE TABLE "scheduled_listings" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "draftId" TEXT,
    "listingId" TEXT,
    "scheduledAt" TIMESTAMP(3) NOT NULL,
    "timezone" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "etsyListingId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "scheduled_listings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "scheduled_listings_status_scheduledAt_idx" ON "scheduled_listings"("status", "scheduledAt");

-- CreateIndex
CREATE INDEX "scheduled_listings_userId_shopId_scheduledAt_idx" ON "scheduled_listings"("userId", "shopId", "scheduledAt");

-- CreateIndex
CREATE INDEX "scheduled_listings_draftId_idx" ON "scheduled_listings"("draftId");

-- AddForeignKey
ALTER TABLE "scheduled_listings" ADD CONSTRAINT "scheduled_listings_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scheduled_listings" ADD CONSTRAINT "scheduled_listings_draftId_fkey" FOREIGN KEY ("draftId") REFERENCES "listing_drafts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

