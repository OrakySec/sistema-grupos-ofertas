-- AlterTable
ALTER TABLE "SourceGroup" ADD COLUMN     "slug" TEXT,
ADD COLUMN     "footerText" TEXT,
ADD COLUMN     "mlOwnListUrl" TEXT,
ADD COLUMN     "mockupTemplatePath" TEXT,
ADD COLUMN     "mockupBoxLeft" INTEGER,
ADD COLUMN     "mockupBoxTop" INTEGER,
ADD COLUMN     "mockupBoxRight" INTEGER,
ADD COLUMN     "mockupBoxBottom" INTEGER,
ADD COLUMN     "mockupCornerRadius" INTEGER;

-- CreateIndex
CREATE UNIQUE INDEX "SourceGroup_slug_key" ON "SourceGroup"("slug");
