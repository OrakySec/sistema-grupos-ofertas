-- Leads: when the person actually got into the group (for the results/retention view)
ALTER TABLE "Lead" ADD COLUMN "joinedAt" TIMESTAMP(3);
UPDATE "Lead" SET "joinedAt" = "processedAt" WHERE "status" = 'ADDED' AND "processedAt" IS NOT NULL;
UPDATE "Lead" SET "joinedAt" = "processedAt" WHERE "status" = 'INVITED' AND "leftAt" IS NOT NULL AND "processedAt" IS NOT NULL;
CREATE INDEX "Lead_tenantId_joinedAt_idx" ON "Lead"("tenantId", "joinedAt");
