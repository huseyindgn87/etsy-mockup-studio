-- AlterTable
ALTER TABLE "listings" ADD COLUMN     "currencyCode" TEXT,
ADD COLUMN     "description" TEXT,
ADD COLUMN     "isPersonalizable" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "isSupply" BOOLEAN,
ADD COLUMN     "itemDimensionsUnit" TEXT,
ADD COLUMN     "itemHeight" DOUBLE PRECISION,
ADD COLUMN     "itemLength" DOUBLE PRECISION,
ADD COLUMN     "itemWeight" DOUBLE PRECISION,
ADD COLUMN     "itemWeightUnit" TEXT,
ADD COLUMN     "itemWidth" DOUBLE PRECISION,
ADD COLUMN     "listingType" TEXT,
ADD COLUMN     "materials" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "personalizationCharCountMax" INTEGER,
ADD COLUMN     "personalizationInstructions" TEXT,
ADD COLUMN     "personalizationIsRequired" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "priceAmount" INTEGER,
ADD COLUMN     "priceDivisor" INTEGER,
ADD COLUMN     "processingMax" INTEGER,
ADD COLUMN     "processingMin" INTEGER,
ADD COLUMN     "returnPolicyId" TEXT,
ADD COLUMN     "shippingProfileId" TEXT,
ADD COLUMN     "syncedAt" TIMESTAMP(3),
ADD COLUMN     "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "whenMade" TEXT,
ADD COLUMN     "whoMade" TEXT;

-- CreateTable
CREATE TABLE "listing_images" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "listingRowId" TEXT NOT NULL,
    "etsyImageId" TEXT,
    "url" TEXT NOT NULL,
    "altText" TEXT,
    "rank" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "listing_images_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "listing_videos" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "listingRowId" TEXT NOT NULL,
    "etsyVideoId" TEXT,
    "url" TEXT NOT NULL,
    "thumbnailUrl" TEXT,
    "rank" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "listing_videos_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "listing_inventory_properties" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "listingRowId" TEXT NOT NULL,
    "etsyPropertyId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "scaleId" TEXT,
    "scaleName" TEXT,
    "rank" INTEGER NOT NULL,
    "priceOnProperty" BOOLEAN NOT NULL DEFAULT false,
    "quantityOnProperty" BOOLEAN NOT NULL DEFAULT false,
    "skuOnProperty" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "listing_inventory_properties_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "listing_inventory_values" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "propertyId" TEXT NOT NULL,
    "etsyValueId" TEXT,
    "value" TEXT NOT NULL,
    "rank" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "listing_inventory_values_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "listing_inventory_products" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "listingRowId" TEXT NOT NULL,
    "etsyProductId" TEXT,
    "etsyOfferingId" TEXT,
    "sku" TEXT,
    "priceAmount" INTEGER NOT NULL,
    "priceDivisor" INTEGER NOT NULL,
    "currencyCode" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "isEnabled" BOOLEAN NOT NULL DEFAULT true,
    "readinessStateId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "listing_inventory_products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "listing_inventory_product_values" (
    "userId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "valueId" TEXT NOT NULL,

    CONSTRAINT "listing_inventory_product_values_pkey" PRIMARY KEY ("productId","valueId")
);

-- CreateIndex
CREATE INDEX "listing_images_userId_idx" ON "listing_images"("userId");

-- CreateIndex
CREATE INDEX "listing_images_listingRowId_rank_idx" ON "listing_images"("listingRowId", "rank");

-- CreateIndex
CREATE INDEX "listing_videos_userId_idx" ON "listing_videos"("userId");

-- CreateIndex
CREATE INDEX "listing_videos_listingRowId_rank_idx" ON "listing_videos"("listingRowId", "rank");

-- CreateIndex
CREATE INDEX "listing_inventory_properties_userId_idx" ON "listing_inventory_properties"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "listing_inventory_properties_listingRowId_etsyPropertyId_key" ON "listing_inventory_properties"("listingRowId", "etsyPropertyId");

-- CreateIndex
CREATE INDEX "listing_inventory_values_userId_idx" ON "listing_inventory_values"("userId");

-- CreateIndex
CREATE INDEX "listing_inventory_values_propertyId_rank_idx" ON "listing_inventory_values"("propertyId", "rank");

-- CreateIndex
CREATE INDEX "listing_inventory_products_userId_idx" ON "listing_inventory_products"("userId");

-- CreateIndex
CREATE INDEX "listing_inventory_products_listingRowId_idx" ON "listing_inventory_products"("listingRowId");

-- CreateIndex
CREATE INDEX "listing_inventory_product_values_userId_idx" ON "listing_inventory_product_values"("userId");

-- CreateIndex
CREATE INDEX "listing_inventory_product_values_valueId_idx" ON "listing_inventory_product_values"("valueId");

-- AddForeignKey
ALTER TABLE "listing_images" ADD CONSTRAINT "listing_images_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "listing_images" ADD CONSTRAINT "listing_images_listingRowId_fkey" FOREIGN KEY ("listingRowId") REFERENCES "listings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "listing_videos" ADD CONSTRAINT "listing_videos_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "listing_videos" ADD CONSTRAINT "listing_videos_listingRowId_fkey" FOREIGN KEY ("listingRowId") REFERENCES "listings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "listing_inventory_properties" ADD CONSTRAINT "listing_inventory_properties_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "listing_inventory_properties" ADD CONSTRAINT "listing_inventory_properties_listingRowId_fkey" FOREIGN KEY ("listingRowId") REFERENCES "listings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "listing_inventory_values" ADD CONSTRAINT "listing_inventory_values_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "listing_inventory_values" ADD CONSTRAINT "listing_inventory_values_propertyId_fkey" FOREIGN KEY ("propertyId") REFERENCES "listing_inventory_properties"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "listing_inventory_products" ADD CONSTRAINT "listing_inventory_products_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "listing_inventory_products" ADD CONSTRAINT "listing_inventory_products_listingRowId_fkey" FOREIGN KEY ("listingRowId") REFERENCES "listings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "listing_inventory_product_values" ADD CONSTRAINT "listing_inventory_product_values_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "listing_inventory_product_values" ADD CONSTRAINT "listing_inventory_product_values_productId_fkey" FOREIGN KEY ("productId") REFERENCES "listing_inventory_products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "listing_inventory_product_values" ADD CONSTRAINT "listing_inventory_product_values_valueId_fkey" FOREIGN KEY ("valueId") REFERENCES "listing_inventory_values"("id") ON DELETE CASCADE ON UPDATE CASCADE;
