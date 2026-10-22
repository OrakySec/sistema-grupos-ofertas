-- Why WhatsApp closed a number's session (shown on its card; pauses the lead queue)
ALTER TABLE "WhatsAppInstance" ADD COLUMN "lastDisconnectAt" TIMESTAMP(3);
ALTER TABLE "WhatsAppInstance" ADD COLUMN "lastDisconnectCode" INTEGER;
