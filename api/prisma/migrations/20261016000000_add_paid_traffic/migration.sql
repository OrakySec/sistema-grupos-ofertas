-- CreateTable
CREATE TABLE "MetaEntity" (
    "id" TEXT NOT NULL,
    "level" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "campaignId" TEXT,
    "adsetId" TEXT,
    "status" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MetaEntity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MetaAdDaily" (
    "id" TEXT NOT NULL,
    "adId" TEXT NOT NULL,
    "adsetId" TEXT,
    "campaignId" TEXT,
    "date" TEXT NOT NULL,
    "spend" DOUBLE PRECISION NOT NULL,
    "impressions" INTEGER NOT NULL,
    "clicks" INTEGER NOT NULL,
    "linkClicks" INTEGER NOT NULL,

    CONSTRAINT "MetaAdDaily_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdLink" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "label" TEXT,
    "metaAdId" TEXT,
    "productUrl" TEXT NOT NULL,
    "shopeeLink" TEXT NOT NULL,
    "finalLink" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShopeeConversion" (
    "id" TEXT NOT NULL,
    "purchaseTime" TIMESTAMP(3) NOT NULL,
    "clickTime" TIMESTAMP(3),
    "utmContent" TEXT,
    "subCode" TEXT,
    "orders" INTEGER NOT NULL DEFAULT 0,
    "items" INTEGER NOT NULL DEFAULT 0,
    "gmv" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "commissionPending" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "commissionConfirmed" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "commissionCancelled" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL,
    "fraud" BOOLEAN NOT NULL DEFAULT false,
    "raw" JSONB,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ShopeeConversion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MetaRule" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "level" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "maxCpc" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "days" INTEGER NOT NULL DEFAULT 2,
    "mode" TEXT NOT NULL DEFAULT 'CONSECUTIVE',
    "minSpend" DOUBLE PRECISION NOT NULL DEFAULT 10,
    "action" TEXT NOT NULL DEFAULT 'NOTIFY',
    "lastFiredAt" TIMESTAMP(3),
    "lastCheck" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MetaRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MetaRuleAction" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "level" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "success" BOOLEAN NOT NULL,
    "detail" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MetaRuleAction_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MetaEntity_level_accountId_idx" ON "MetaEntity"("level", "accountId");

-- CreateIndex
CREATE INDEX "MetaEntity_campaignId_idx" ON "MetaEntity"("campaignId");

-- CreateIndex
CREATE INDEX "MetaEntity_adsetId_idx" ON "MetaEntity"("adsetId");

-- CreateIndex
CREATE INDEX "MetaAdDaily_date_idx" ON "MetaAdDaily"("date");

-- CreateIndex
CREATE INDEX "MetaAdDaily_campaignId_date_idx" ON "MetaAdDaily"("campaignId", "date");

-- CreateIndex
CREATE INDEX "MetaAdDaily_adsetId_date_idx" ON "MetaAdDaily"("adsetId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "MetaAdDaily_adId_date_key" ON "MetaAdDaily"("adId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "AdLink_code_key" ON "AdLink"("code");

-- CreateIndex
CREATE INDEX "AdLink_metaAdId_idx" ON "AdLink"("metaAdId");

-- CreateIndex
CREATE INDEX "ShopeeConversion_purchaseTime_idx" ON "ShopeeConversion"("purchaseTime");

-- CreateIndex
CREATE INDEX "ShopeeConversion_subCode_purchaseTime_idx" ON "ShopeeConversion"("subCode", "purchaseTime");

-- CreateIndex
CREATE UNIQUE INDEX "MetaRule_entityId_key" ON "MetaRule"("entityId");

-- CreateIndex
CREATE INDEX "MetaRuleAction_createdAt_idx" ON "MetaRuleAction"("createdAt");

