-- CreateTable
CREATE TABLE "mockup_calibrations" (
    "id" TEXT NOT NULL,
    "etsyUserId" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mockup_calibrations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "mockup_calibrations_etsyUserId_idx" ON "mockup_calibrations"("etsyUserId");

-- CreateIndex
CREATE UNIQUE INDEX "mockup_calibrations_etsyUserId_contentHash_key" ON "mockup_calibrations"("etsyUserId", "contentHash");
