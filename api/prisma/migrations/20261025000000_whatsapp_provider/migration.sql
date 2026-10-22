-- Which WhatsApp API a number lives in: EVOLUTION (default, every existing number) or WAHA
ALTER TABLE "WhatsAppInstance" ADD COLUMN "provider" TEXT NOT NULL DEFAULT 'EVOLUTION';
