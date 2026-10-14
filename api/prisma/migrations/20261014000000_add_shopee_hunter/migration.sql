-- AlterTable
ALTER TABLE "SourceGroup" ADD COLUMN     "kind" TEXT NOT NULL DEFAULT 'TELEGRAM';

-- CreateTable
CREATE TABLE "ShopeeHunter" (
    "id" TEXT NOT NULL,
    "nicheId" TEXT NOT NULL,
    "sourceGroupId" TEXT NOT NULL,
    "mode" TEXT NOT NULL DEFAULT 'OFF',
    "keywords" TEXT NOT NULL DEFAULT '',
    "forbiddenWords" TEXT NOT NULL DEFAULT '',
    "minPrice" DOUBLE PRECISION,
    "maxPrice" DOUBLE PRECISION,
    "minRating" DOUBLE PRECISION NOT NULL DEFAULT 4.5,
    "minSales" INTEGER NOT NULL DEFAULT 100,
    "minCommissionPct" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "minDiscountPct" DOUBLE PRECISION NOT NULL DEFAULT 15,
    "minScore" INTEGER NOT NULL DEFAULT 60,
    "autoMinScore" INTEGER NOT NULL DEFAULT 80,
    "officialOnly" BOOLEAN NOT NULL DEFAULT false,
    "intervalHours" INTEGER NOT NULL DEFAULT 3,
    "dailyLimit" INTEGER NOT NULL DEFAULT 12,
    "minIntervalMin" INTEGER NOT NULL DEFAULT 20,
    "quietStart" INTEGER NOT NULL DEFAULT 23,
    "quietEnd" INTEGER NOT NULL DEFAULT 7,
    "useCoupons" BOOLEAN NOT NULL DEFAULT true,
    "lastRunAt" TIMESTAMP(3),
    "lastRunSummary" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ShopeeHunter_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShopeeProduct" (
    "id" TEXT NOT NULL,
    "itemId" BIGINT NOT NULL,
    "shopId" BIGINT NOT NULL,
    "name" TEXT NOT NULL,
    "imageUrl" TEXT,
    "productLink" TEXT,
    "offerLink" TEXT,
    "shopName" TEXT,
    "isOfficial" BOOLEAN NOT NULL DEFAULT false,
    "ratingStar" DOUBLE PRECISION,
    "sales" INTEGER,
    "commissionPct" DOUBLE PRECISION,
    "lastPrice" DOUBLE PRECISION NOT NULL,
    "lastPriceMax" DOUBLE PRECISION,
    "lastDiscountPct" DOUBLE PRECISION,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ShopeeProduct_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShopeePricePoint" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "price" DOUBLE PRECISION NOT NULL,
    "discountPct" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ShopeePricePoint_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HunterCandidate" (
    "id" TEXT NOT NULL,
    "hunterId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "keyword" TEXT NOT NULL,
    "price" DOUBLE PRECISION NOT NULL,
    "originalPrice" DOUBLE PRECISION,
    "discountPct" DOUBLE PRECISION,
    "discountSource" TEXT NOT NULL,
    "score" INTEGER NOT NULL,
    "scoreDetail" JSONB,
    "status" TEXT NOT NULL,
    "offerId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedAt" TIMESTAMP(3),

    CONSTRAINT "HunterCandidate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Coupon" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "discountType" TEXT NOT NULL,
    "value" DOUBLE PRECISION NOT NULL,
    "maxDiscount" DOUBLE PRECISION,
    "minSpend" DOUBLE PRECISION,
    "validUntil" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "endReason" TEXT,
    "endedAt" TIMESTAMP(3),
    "sources" JSONB,
    "sourceCount" INTEGER NOT NULL DEFAULT 1,
    "mentions" INTEGER NOT NULL DEFAULT 1,
    "usedCount" INTEGER NOT NULL DEFAULT 0,
    "sample" TEXT,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Coupon_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ShopeeHunter_nicheId_key" ON "ShopeeHunter"("nicheId");

-- CreateIndex
CREATE UNIQUE INDEX "ShopeeHunter_sourceGroupId_key" ON "ShopeeHunter"("sourceGroupId");

-- CreateIndex
CREATE UNIQUE INDEX "ShopeeProduct_shopId_itemId_key" ON "ShopeeProduct"("shopId", "itemId");

-- CreateIndex
CREATE INDEX "ShopeePricePoint_productId_createdAt_idx" ON "ShopeePricePoint"("productId", "createdAt");

-- CreateIndex
CREATE INDEX "HunterCandidate_hunterId_status_createdAt_idx" ON "HunterCandidate"("hunterId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "HunterCandidate_productId_createdAt_idx" ON "HunterCandidate"("productId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Coupon_code_key" ON "Coupon"("code");

-- CreateIndex
CREATE INDEX "Coupon_status_idx" ON "Coupon"("status");

-- AddForeignKey
ALTER TABLE "ShopeeHunter" ADD CONSTRAINT "ShopeeHunter_nicheId_fkey" FOREIGN KEY ("nicheId") REFERENCES "Niche"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShopeeHunter" ADD CONSTRAINT "ShopeeHunter_sourceGroupId_fkey" FOREIGN KEY ("sourceGroupId") REFERENCES "SourceGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShopeePricePoint" ADD CONSTRAINT "ShopeePricePoint_productId_fkey" FOREIGN KEY ("productId") REFERENCES "ShopeeProduct"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HunterCandidate" ADD CONSTRAINT "HunterCandidate_hunterId_fkey" FOREIGN KEY ("hunterId") REFERENCES "ShopeeHunter"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HunterCandidate" ADD CONSTRAINT "HunterCandidate_productId_fkey" FOREIGN KEY ("productId") REFERENCES "ShopeeProduct"("id") ON DELETE CASCADE ON UPDATE CASCADE;

