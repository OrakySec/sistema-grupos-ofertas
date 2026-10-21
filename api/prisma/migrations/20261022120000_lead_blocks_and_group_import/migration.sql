-- Leads: never re-add someone who left one of our groups + import from a group

ALTER TABLE "Lead" ADD COLUMN "source" TEXT NOT NULL DEFAULT 'LIST';
ALTER TABLE "Lead" ADD COLUMN "leftAt" TIMESTAMP(3);

CREATE TABLE "LeadBlock" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "groupId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LeadBlock_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "LeadBlock_tenantId_phone_key" ON "LeadBlock"("tenantId", "phone");
ALTER TABLE "LeadBlock" ADD CONSTRAINT "LeadBlock_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
