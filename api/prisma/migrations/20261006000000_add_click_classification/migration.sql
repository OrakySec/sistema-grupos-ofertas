-- AlterTable
ALTER TABLE "ShortUrlClick" ADD COLUMN     "kind" TEXT NOT NULL DEFAULT 'LEGACY',
ADD COLUMN     "agent" TEXT,
ADD COLUMN     "userAgent" TEXT,
ADD COLUMN     "ipHash" TEXT;

-- CreateIndex
CREATE INDEX "ShortUrlClick_createdAt_idx" ON "ShortUrlClick"("createdAt");

-- CreateIndex
CREATE INDEX "ShortUrlClick_code_ipHash_createdAt_idx" ON "ShortUrlClick"("code", "ipHash", "createdAt");
