-- Product finder: sweep Shopee by category instead of search terms
CREATE TABLE "ShopeeCategory" (
    "id" TEXT NOT NULL,
    "level" INTEGER,
    "products" INTEGER NOT NULL DEFAULT 0,
    "lastScannedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ShopeeCategory_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ShopeeCategory_lastScannedAt_idx" ON "ShopeeCategory"("lastScannedAt");
