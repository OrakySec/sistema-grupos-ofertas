-- Favorites: products picked to test as ads, one by one
CREATE TABLE "ShopeeFavorite" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL DEFAULT 'tenant_default',
    "productId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'QUEUE',
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ShopeeFavorite_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ShopeeFavorite_tenantId_productId_key" ON "ShopeeFavorite"("tenantId", "productId");
CREATE INDEX "ShopeeFavorite_tenantId_status_idx" ON "ShopeeFavorite"("tenantId", "status");

ALTER TABLE "ShopeeFavorite" ADD CONSTRAINT "ShopeeFavorite_productId_fkey" FOREIGN KEY ("productId") REFERENCES "ShopeeProduct"("id") ON DELETE CASCADE ON UPDATE CASCADE;
