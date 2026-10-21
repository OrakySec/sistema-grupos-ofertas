-- SaaS accounts (minimal slice) + WhatsApp numbers by QR code + lead adding

CREATE TABLE "Tenant" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Tenant_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Tenant_slug_key" ON "Tenant"("slug");

-- The original owner becomes account #1.
INSERT INTO "Tenant" ("id", "slug", "name") VALUES ('tenant_default', 'default', 'Conta principal');

CREATE TABLE "WhatsAppInstance" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "purpose" TEXT NOT NULL DEFAULT 'LEADS',
    "connected" BOOLEAN NOT NULL DEFAULT false,
    "number" TEXT,
    "profileName" TEXT,
    "lastState" TEXT,
    "lastSeenAt" TIMESTAMP(3),
    "leadSafety" JSONB,
    "leadPaused" BOOLEAN NOT NULL DEFAULT false,
    "leadPausedReason" TEXT,
    "leadNextAt" TIMESTAMP(3),
    "leadRestUntil" TIMESTAMP(3),
    "leadSinceRest" INTEGER NOT NULL DEFAULT 0,
    "leadFailStreak" INTEGER NOT NULL DEFAULT 0,
    "leadWarmupFrom" TIMESTAMP(3),
    "leadLastResult" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WhatsAppInstance_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "WhatsAppInstance_name_key" ON "WhatsAppInstance"("name");
CREATE INDEX "WhatsAppInstance_tenantId_idx" ON "WhatsAppInstance"("tenantId");
ALTER TABLE "WhatsAppInstance" ADD CONSTRAINT "WhatsAppInstance_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The number already posting the offers (configured by hand in Configurações)
-- shows up in the new list as account #1's offers number.
INSERT INTO "WhatsAppInstance" ("id", "tenantId", "name", "label", "purpose", "updatedAt")
SELECT 'wa_legacy_offers', 'tenant_default', "value", 'Número das ofertas', 'OFFERS', CURRENT_TIMESTAMP
FROM "Setting" WHERE "key" = 'evolution_instance' AND "value" <> '';

CREATE TABLE "LeadCampaign" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "nicheId" TEXT,
    "instanceId" TEXT NOT NULL,
    "groupIds" JSONB NOT NULL,
    "inviteFallback" BOOLEAN NOT NULL DEFAULT true,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "pausedReason" TEXT,
    "intakeToken" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LeadCampaign_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "LeadCampaign_intakeToken_key" ON "LeadCampaign"("intakeToken");
CREATE INDEX "LeadCampaign_tenantId_createdAt_idx" ON "LeadCampaign"("tenantId", "createdAt");
ALTER TABLE "LeadCampaign" ADD CONSTRAINT "LeadCampaign_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "LeadCampaign" ADD CONSTRAINT "LeadCampaign_instanceId_fkey" FOREIGN KEY ("instanceId") REFERENCES "WhatsAppInstance"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "Lead" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "name" TEXT,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "groupId" TEXT,
    "instanceId" TEXT,
    "detail" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "processedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Lead_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Lead_campaignId_phone_key" ON "Lead"("campaignId", "phone");
CREATE INDEX "Lead_campaignId_status_createdAt_idx" ON "Lead"("campaignId", "status", "createdAt");
CREATE INDEX "Lead_instanceId_processedAt_idx" ON "Lead"("instanceId", "processedAt");
CREATE INDEX "Lead_tenantId_status_idx" ON "Lead"("tenantId", "status");
ALTER TABLE "Lead" ADD CONSTRAINT "Lead_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Lead" ADD CONSTRAINT "Lead_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "LeadCampaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;
