-- WhatsApp groups as offer sources (kind WHATSAPP): read through one of the account's numbers
ALTER TABLE "SourceGroup" ADD COLUMN "whatsappJid" TEXT;
ALTER TABLE "SourceGroup" ADD COLUMN "readerInstance" TEXT;
CREATE UNIQUE INDEX "SourceGroup_whatsappJid_key" ON "SourceGroup"("whatsappJid");
