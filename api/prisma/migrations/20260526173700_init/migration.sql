-- CreateEnum
CREATE TYPE "DestinationType" AS ENUM ('TELEGRAM', 'WHATSAPP');

-- CreateEnum
CREATE TYPE "MediaType" AS ENUM ('NONE', 'PHOTO', 'VIDEO', 'DOCUMENT');

-- CreateEnum
CREATE TYPE "OfferStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'SENT', 'FAILED');

-- CreateEnum
CREATE TYPE "DeliveryStatus" AS ENUM ('SUCCESS', 'FAILED');

-- CreateTable
CREATE TABLE "SourceGroup" (
    "id" TEXT NOT NULL,
    "telegramId" BIGINT NOT NULL,
    "name" TEXT NOT NULL,
    "username" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SourceGroup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DestinationGroup" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "DestinationType" NOT NULL,
    "chatId" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DestinationGroup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Offer" (
    "id" TEXT NOT NULL,
    "sourceGroupId" TEXT NOT NULL,
    "telegramMessageId" BIGINT NOT NULL,
    "text" TEXT,
    "mediaType" "MediaType" NOT NULL DEFAULT 'NONE',
    "mediaLocalPath" TEXT,
    "mediaCaption" TEXT,
    "senderName" TEXT,
    "status" "OfferStatus" NOT NULL DEFAULT 'PENDING',
    "originalDate" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewedAt" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),

    CONSTRAINT "Offer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeliveryLog" (
    "id" TEXT NOT NULL,
    "offerId" TEXT NOT NULL,
    "destinationGroupId" TEXT NOT NULL,
    "status" "DeliveryStatus" NOT NULL,
    "errorMessage" TEXT,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeliveryLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Setting" (
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Setting_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE UNIQUE INDEX "SourceGroup_telegramId_key" ON "SourceGroup"("telegramId");

-- CreateIndex
CREATE UNIQUE INDEX "Offer_telegramMessageId_sourceGroupId_key" ON "Offer"("telegramMessageId", "sourceGroupId");

-- AddForeignKey
ALTER TABLE "Offer" ADD CONSTRAINT "Offer_sourceGroupId_fkey" FOREIGN KEY ("sourceGroupId") REFERENCES "SourceGroup"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeliveryLog" ADD CONSTRAINT "DeliveryLog_offerId_fkey" FOREIGN KEY ("offerId") REFERENCES "Offer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeliveryLog" ADD CONSTRAINT "DeliveryLog_destinationGroupId_fkey" FOREIGN KEY ("destinationGroupId") REFERENCES "DestinationGroup"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
