-- AlterTable
ALTER TABLE "DestinationGroup" ADD COLUMN     "inviteLink" TEXT,
ADD COLUMN     "linkStatus" TEXT DEFAULT 'UNKNOWN',
ADD COLUMN     "linkLastCheckedAt" TIMESTAMP(3),
ADD COLUMN     "linkLastNotifiedAt" TIMESTAMP(3);
