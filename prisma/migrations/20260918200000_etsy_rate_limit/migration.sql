-- Global Etsy API rate-limit state (lib/etsy/client.ts). One row, id "global".
CREATE TABLE "etsy_rate_limit" (
    "id" TEXT NOT NULL,
    "perSecondLimit" INTEGER,
    "perDayLimit" INTEGER,
    "remainingToday" INTEGER,
    "observedAt" TIMESTAMP(3),
    "windowStartMs" BIGINT NOT NULL DEFAULT 0,
    "windowCount" INTEGER NOT NULL DEFAULT 0,
    "pausedUntil" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "etsy_rate_limit_pkey" PRIMARY KEY ("id")
);
