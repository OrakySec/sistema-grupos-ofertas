-- Meta Purchase event for Shopee sales from ads
ALTER TABLE "ShopeeConversion" ADD COLUMN "purchaseEventStatus" TEXT;
ALTER TABLE "ShopeeConversion" ADD COLUMN "purchaseEventDetail" TEXT;
ALTER TABLE "ShopeeConversion" ADD COLUMN "purchaseEventAt" TIMESTAMP(3);
ALTER TABLE "ShopeeConversion" ADD COLUMN "purchaseEventAttempts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "ShopeeConversion" ADD COLUMN "purchaseClickId" TEXT;

CREATE TABLE "AdClick" (
    "id" TEXT NOT NULL,
    "adCode" TEXT NOT NULL,
    "shortCode" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "fbc" TEXT,
    "fbp" TEXT NOT NULL,
    "ip" TEXT NOT NULL,
    "userAgent" TEXT,

    CONSTRAINT "AdClick_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AdClick_adCode_createdAt_idx" ON "AdClick"("adCode", "createdAt");
CREATE INDEX "AdClick_createdAt_idx" ON "AdClick"("createdAt");
