-- AlterTable
ALTER TABLE "ShopeeHunter" ADD COLUMN     "requireKeywordInTitle" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "HunterCandidate" ADD COLUMN     "signature" TEXT;

-- CreateIndex
CREATE INDEX "HunterCandidate_signature_decidedAt_idx" ON "HunterCandidate"("signature", "decidedAt");

