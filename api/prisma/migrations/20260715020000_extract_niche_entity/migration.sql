-- DropIndex (old per-SourceGroup slug, being replaced by Niche.slug)
DROP INDEX "SourceGroup_slug_key";

-- AlterTable: drop the direct niche-config columns, add nicheId FK
ALTER TABLE "SourceGroup"
  DROP COLUMN "slug",
  DROP COLUMN "footerText",
  DROP COLUMN "mlOwnListUrl",
  DROP COLUMN "mockupTemplatePath",
  DROP COLUMN "mockupBoxLeft",
  DROP COLUMN "mockupBoxTop",
  DROP COLUMN "mockupBoxRight",
  DROP COLUMN "mockupBoxBottom",
  DROP COLUMN "mockupCornerRadius",
  ADD COLUMN     "nicheId" TEXT;

-- CreateTable
CREATE TABLE "Niche" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT,
    "footerText" TEXT,
    "mlOwnListUrl" TEXT,
    "mockupTemplatePath" TEXT,
    "mockupBoxLeft" INTEGER,
    "mockupBoxTop" INTEGER,
    "mockupBoxRight" INTEGER,
    "mockupBoxBottom" INTEGER,
    "mockupCornerRadius" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Niche_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Niche_slug_key" ON "Niche"("slug");

-- AddForeignKey
ALTER TABLE "SourceGroup" ADD CONSTRAINT "SourceGroup_nicheId_fkey" FOREIGN KEY ("nicheId") REFERENCES "Niche"("id") ON DELETE SET NULL ON UPDATE CASCADE;
