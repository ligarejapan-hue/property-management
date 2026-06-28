CREATE TABLE IF NOT EXISTS "sales_sheet_designs" (
  "id" TEXT NOT NULL,
  "propertyId" UUID NOT NULL,
  "title" TEXT NOT NULL DEFAULT '無題の販売図面',
  "document" JSONB NOT NULL,
  "templateId" TEXT,
  "thumbnailUrl" TEXT,
  "createdBy" TEXT NOT NULL,
  "updatedBy" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "sales_sheet_designs_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "sales_sheet_designs_propertyId_idx" ON "sales_sheet_designs"("propertyId");
ALTER TABLE "sales_sheet_designs" ADD CONSTRAINT "sales_sheet_designs_propertyId_fkey"
  FOREIGN KEY ("propertyId") REFERENCES "properties"("id") ON DELETE CASCADE ON UPDATE CASCADE;
