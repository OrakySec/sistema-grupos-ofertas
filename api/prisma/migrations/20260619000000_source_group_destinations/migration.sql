-- CreateTable
CREATE TABLE IF NOT EXISTS "SourceGroupDestination" (
    "sourceGroupId"      TEXT NOT NULL,
    "destinationGroupId" TEXT NOT NULL,

    CONSTRAINT "SourceGroupDestination_pkey" PRIMARY KEY ("sourceGroupId","destinationGroupId")
);

-- AddForeignKey
ALTER TABLE "SourceGroupDestination"
    ADD CONSTRAINT "fk_sgd_source"
    FOREIGN KEY ("sourceGroupId")
    REFERENCES "SourceGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SourceGroupDestination"
    ADD CONSTRAINT "fk_sgd_dest"
    FOREIGN KEY ("destinationGroupId")
    REFERENCES "DestinationGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;
