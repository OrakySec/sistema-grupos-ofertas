-- CreateTable
CREATE TABLE "ShortUrlClick" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ShortUrlClick_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "ShortUrlClick" ADD CONSTRAINT "ShortUrlClick_code_fkey" FOREIGN KEY ("code") REFERENCES "ShortUrl"("code") ON DELETE CASCADE ON UPDATE CASCADE;
