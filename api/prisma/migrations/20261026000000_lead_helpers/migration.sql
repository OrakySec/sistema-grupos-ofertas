-- Phones that add people by hand ("Adicionar pelo celular"): they get a daily batch from the main number
CREATE TABLE "LeadHelper" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "safety" JSONB,
    "paused" BOOLEAN NOT NULL DEFAULT false,
    "pausedReason" TEXT,
    "restUntil" TIMESTAMP(3),
    "sinceRest" INTEGER NOT NULL DEFAULT 0,
    "warmupFrom" TIMESTAMP(3),
    "lastSentAt" TIMESTAMP(3),
    "lastResult" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LeadHelper_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "LeadHelper_tenantId_idx" ON "LeadHelper"("tenantId");
ALTER TABLE "LeadHelper" ADD CONSTRAINT "LeadHelper_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "LeadCampaignHelper" (
    "campaignId" TEXT NOT NULL,
    "helperId" TEXT NOT NULL,

    CONSTRAINT "LeadCampaignHelper_pkey" PRIMARY KEY ("campaignId","helperId")
);
CREATE INDEX "LeadCampaignHelper_helperId_idx" ON "LeadCampaignHelper"("helperId");
ALTER TABLE "LeadCampaignHelper" ADD CONSTRAINT "LeadCampaignHelper_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "LeadCampaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "LeadCampaignHelper" ADD CONSTRAINT "LeadCampaignHelper_helperId_fkey" FOREIGN KEY ("helperId") REFERENCES "LeadHelper"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Lead" ADD COLUMN "helperId" TEXT;
CREATE INDEX "Lead_helperId_processedAt_idx" ON "Lead"("helperId", "processedAt");
