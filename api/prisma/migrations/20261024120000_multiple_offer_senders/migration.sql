-- Several numbers can post the offers (random admin per group)
ALTER TABLE "WhatsAppInstance" ADD COLUMN "sendsOffers" BOOLEAN NOT NULL DEFAULT false;
UPDATE "WhatsAppInstance" SET "sendsOffers" = true WHERE "purpose" = 'OFFERS';

ALTER TABLE "DeliveryLog" ADD COLUMN "senderInstance" TEXT;
CREATE INDEX "DeliveryLog_senderInstance_sentAt_idx" ON "DeliveryLog"("senderInstance", "sentAt");
