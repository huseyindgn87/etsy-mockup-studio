-- Etsy job queue (lib/jobs/).
CREATE TABLE "etsy_jobs" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "shopId" TEXT,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "priority" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 3,
    "progress" JSONB,
    "result" JSONB,
    "error" TEXT,
    "activeKey" TEXT,
    "runAfter" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lockToken" TEXT,
    "lockedUntil" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "etsy_jobs_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "etsy_jobs_activeKey_key" ON "etsy_jobs"("activeKey");
CREATE INDEX "etsy_jobs_status_priority_runAfter_idx" ON "etsy_jobs"("status", "priority", "runAfter");
CREATE INDEX "etsy_jobs_userId_createdAt_idx" ON "etsy_jobs"("userId", "createdAt");

ALTER TABLE "etsy_jobs" ADD CONSTRAINT "etsy_jobs_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "etsy_job_turns" (
    "userId" TEXT NOT NULL,
    "lastServedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "etsy_job_turns_pkey" PRIMARY KEY ("userId")
);

-- A cached access token for background work, encrypted like the refresh token.
ALTER TABLE "etsy_shop_connections" ADD COLUMN "accessToken" TEXT,
ADD COLUMN "accessTokenExpiresAt" TIMESTAMP(3);
