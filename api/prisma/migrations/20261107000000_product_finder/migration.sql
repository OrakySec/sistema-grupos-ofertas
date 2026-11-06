-- Product finder: daily sales readings per Shopee product → sales per day
ALTER TABLE "ShopeeProduct" ADD COLUMN "commissionValue" DOUBLE PRECISION;
ALTER TABLE "ShopeeProduct" ADD COLUMN "categoryIds" TEXT;
ALTER TABLE "ShopeeProduct" ADD COLUMN "salesPerDay" DOUBLE PRECISION;
ALTER TABLE "ShopeeProduct" ADD COLUMN "salesTrend" DOUBLE PRECISION;
ALTER TABLE "ShopeeProduct" ADD COLUMN "finderSeenAt" TIMESTAMP(3);
CREATE INDEX "ShopeeProduct_finderSeenAt_idx" ON "ShopeeProduct"("finderSeenAt");

CREATE TABLE "ShopeeSalesSnapshot" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "day" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sales" INTEGER NOT NULL,
    "price" DOUBLE PRECISION NOT NULL,
    "commissionPct" DOUBLE PRECISION,

    CONSTRAINT "ShopeeSalesSnapshot_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ShopeeSalesSnapshot_productId_day_key" ON "ShopeeSalesSnapshot"("productId", "day");
CREATE INDEX "ShopeeSalesSnapshot_at_idx" ON "ShopeeSalesSnapshot"("at");

ALTER TABLE "ShopeeSalesSnapshot" ADD CONSTRAINT "ShopeeSalesSnapshot_productId_fkey" FOREIGN KEY ("productId") REFERENCES "ShopeeProduct"("id") ON DELETE CASCADE ON UPDATE CASCADE;
