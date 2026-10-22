-- How a lead list puts people in the group: ADD (direct add, link in private on privacy) or INVITE (link in private only)
ALTER TABLE "LeadCampaign" ADD COLUMN "mode" TEXT NOT NULL DEFAULT 'ADD';
