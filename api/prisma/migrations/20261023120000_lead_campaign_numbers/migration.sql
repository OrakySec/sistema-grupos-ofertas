-- Several WhatsApp numbers working the same lead list

CREATE TABLE "LeadCampaignNumber" (
    "campaignId" TEXT NOT NULL,
    "instanceId" TEXT NOT NULL,

    CONSTRAINT "LeadCampaignNumber_pkey" PRIMARY KEY ("campaignId", "instanceId")
);
CREATE INDEX "LeadCampaignNumber_instanceId_idx" ON "LeadCampaignNumber"("instanceId");
ALTER TABLE "LeadCampaignNumber" ADD CONSTRAINT "LeadCampaignNumber_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "LeadCampaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "LeadCampaignNumber" ADD CONSTRAINT "LeadCampaignNumber_instanceId_fkey" FOREIGN KEY ("instanceId") REFERENCES "WhatsAppInstance"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Existing lists keep their number.
INSERT INTO "LeadCampaignNumber" ("campaignId", "instanceId") SELECT "id", "instanceId" FROM "LeadCampaign";
