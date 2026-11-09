-- One ad link can run in many ads (duplicated campaigns keep the same link)
CREATE TABLE "AdLinkAd" (
    "id" TEXT NOT NULL,
    "linkId" TEXT NOT NULL,
    "adId" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'MANUAL',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdLinkAd_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AdLinkAd_linkId_adId_key" ON "AdLinkAd"("linkId", "adId");
CREATE INDEX "AdLinkAd_adId_idx" ON "AdLinkAd"("adId");

ALTER TABLE "AdLinkAd" ADD CONSTRAINT "AdLinkAd_linkId_fkey" FOREIGN KEY ("linkId") REFERENCES "AdLink"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The ad each link was already tied to carries over.
INSERT INTO "AdLinkAd" ("id", "linkId", "adId", "source")
SELECT 'migrated_' || "id", "id", "metaAdId", 'MANUAL' FROM "AdLink" WHERE "metaAdId" IS NOT NULL;
