-- AlterTable
ALTER TABLE "DestinationGroup" ADD COLUMN     "seq" SERIAL NOT NULL;

-- AlterTable
ALTER TABLE "ShortUrlClick" ADD COLUMN     "destinationGroupId" TEXT;

-- CreateTable
CREATE TABLE "WaMember" (
    "id" TEXT NOT NULL,
    "destinationGroupId" TEXT NOT NULL,
    "memberHash" TEXT NOT NULL,
    "joinedAt" TIMESTAMP(3),
    "leftAt" TIMESTAMP(3),
    "joinCount" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WaMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WaMemberEvent" (
    "id" TEXT NOT NULL,
    "destinationGroupId" TEXT NOT NULL,
    "memberHash" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "memberJoinedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WaMemberEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WaGroupSnapshot" (
    "id" TEXT NOT NULL,
    "destinationGroupId" TEXT NOT NULL,
    "memberCount" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WaGroupSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "WaMember_destinationGroupId_leftAt_idx" ON "WaMember"("destinationGroupId", "leftAt");

-- CreateIndex
CREATE UNIQUE INDEX "WaMember_destinationGroupId_memberHash_key" ON "WaMember"("destinationGroupId", "memberHash");

-- CreateIndex
CREATE INDEX "WaMemberEvent_destinationGroupId_createdAt_idx" ON "WaMemberEvent"("destinationGroupId", "createdAt");

-- CreateIndex
CREATE INDEX "WaMemberEvent_destinationGroupId_memberHash_createdAt_idx" ON "WaMemberEvent"("destinationGroupId", "memberHash", "createdAt");

-- CreateIndex
CREATE INDEX "WaGroupSnapshot_destinationGroupId_createdAt_idx" ON "WaGroupSnapshot"("destinationGroupId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "DestinationGroup_seq_key" ON "DestinationGroup"("seq");

-- CreateIndex
CREATE INDEX "ShortUrlClick_destinationGroupId_createdAt_idx" ON "ShortUrlClick"("destinationGroupId", "createdAt");

-- AddForeignKey
ALTER TABLE "WaMember" ADD CONSTRAINT "WaMember_destinationGroupId_fkey" FOREIGN KEY ("destinationGroupId") REFERENCES "DestinationGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WaMemberEvent" ADD CONSTRAINT "WaMemberEvent_destinationGroupId_fkey" FOREIGN KEY ("destinationGroupId") REFERENCES "DestinationGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WaGroupSnapshot" ADD CONSTRAINT "WaGroupSnapshot_destinationGroupId_fkey" FOREIGN KEY ("destinationGroupId") REFERENCES "DestinationGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;

