-- Add processingLog JSON column to Offer table
-- This stores the affiliate link conversion trace for each message

ALTER TABLE "Offer" ADD COLUMN IF NOT EXISTS "processingLog" JSONB;
