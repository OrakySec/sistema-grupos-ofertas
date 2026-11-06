-- Sales analysis: where each sale came from, its items, and ad spend typed in by hand
ALTER TABLE "ShopeeConversion" ADD COLUMN "channel" TEXT;

CREATE TABLE "ShopeeOrderItem" (
    "id" TEXT NOT NULL,
    "conversionId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL DEFAULT 'tenant_default',
    "orderId" TEXT NOT NULL,
    "orderStatus" TEXT NOT NULL,
    "purchaseTime" TIMESTAMP(3) NOT NULL,
    "clickTime" TIMESTAMP(3),
    "subCode" TEXT,
    "channel" TEXT,
    "itemId" TEXT,
    "itemName" TEXT,
    "imageUrl" TEXT,
    "shopId" TEXT,
    "shopName" TEXT,
    "categoryL1" TEXT,
    "qty" INTEGER NOT NULL DEFAULT 1,
    "price" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "amount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "commission" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "shopeeCommission" DOUBLE PRECISION,
    "sellerCommission" DOUBLE PRECISION,
    "attribution" TEXT,
    "fraud" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "ShopeeOrderItem_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ShopeeOrderItem_tenantId_purchaseTime_idx" ON "ShopeeOrderItem"("tenantId", "purchaseTime");
CREATE INDEX "ShopeeOrderItem_subCode_purchaseTime_idx" ON "ShopeeOrderItem"("subCode", "purchaseTime");
CREATE INDEX "ShopeeOrderItem_conversionId_idx" ON "ShopeeOrderItem"("conversionId");
ALTER TABLE "ShopeeOrderItem" ADD CONSTRAINT "ShopeeOrderItem_conversionId_fkey" FOREIGN KEY ("conversionId") REFERENCES "ShopeeConversion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "ManualAdSpend" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL DEFAULT 'tenant_default',
    "subCode" TEXT NOT NULL,
    "startDate" TEXT NOT NULL,
    "endDate" TEXT NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ManualAdSpend_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ManualAdSpend_tenantId_subCode_idx" ON "ManualAdSpend"("tenantId", "subCode");
