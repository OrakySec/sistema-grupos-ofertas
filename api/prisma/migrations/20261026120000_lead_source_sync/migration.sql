-- Lists made from a group's members: the source group is re-read daily and new members join the queue
ALTER TABLE "LeadCampaign" ADD COLUMN "sourceGroupJid" TEXT;
ALTER TABLE "LeadCampaign" ADD COLUMN "sourceGroupName" TEXT;
ALTER TABLE "LeadCampaign" ADD COLUMN "sourceSync" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "LeadCampaign" ADD COLUMN "sourceSyncedAt" TIMESTAMP(3);
ALTER TABLE "LeadCampaign" ADD COLUMN "sourceSyncResult" TEXT;
