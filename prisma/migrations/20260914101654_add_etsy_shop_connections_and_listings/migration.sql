-- CreateTable
CREATE TABLE "etsy_shop_connections" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "etsyUserId" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "shopName" TEXT NOT NULL,
    "shopIconUrl" TEXT,
    "refreshToken" TEXT NOT NULL,
    "lastSyncedAt" TIMESTAMP(3),
    "lastConnectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "etsy_shop_connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "listings" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "listingId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "price" TEXT,
    "thumbnailUrl" TEXT,
    "endingAt" TIMESTAMP(3),
    "shopSectionId" INTEGER,
    "sku" TEXT,
    "removedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "listings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "etsy_shop_connections_userId_idx" ON "etsy_shop_connections"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "etsy_shop_connections_userId_shopId_key" ON "etsy_shop_connections"("userId", "shopId");

-- CreateIndex
CREATE INDEX "listings_userId_shopId_state_idx" ON "listings"("userId", "shopId", "state");

-- CreateIndex
CREATE UNIQUE INDEX "listings_userId_shopId_listingId_key" ON "listings"("userId", "shopId", "listingId");

-- AddForeignKey
ALTER TABLE "etsy_shop_connections" ADD CONSTRAINT "etsy_shop_connections_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "listings" ADD CONSTRAINT "listings_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
