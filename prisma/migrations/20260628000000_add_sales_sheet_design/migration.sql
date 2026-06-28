CREATE TABLE IF NOT EXISTS "sales_sheet_designs" (
  "id" TEXT NOT NULL,
  "property_id" UUID NOT NULL,
  "title" TEXT NOT NULL DEFAULT '無題の販売図面',
  "document" JSONB NOT NULL,
  "template_id" TEXT,
  "thumbnail_url" TEXT,
  "created_by" UUID NOT NULL,
  "updated_by" UUID NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "sales_sheet_designs_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "sales_sheet_designs_property_id_idx" ON "sales_sheet_designs"("property_id");
ALTER TABLE "sales_sheet_designs" ADD CONSTRAINT "sales_sheet_designs_property_id_fkey"
  FOREIGN KEY ("property_id") REFERENCES "properties"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "sales_sheet_designs" ADD CONSTRAINT "sales_sheet_designs_created_by_fkey"
  FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "sales_sheet_designs" ADD CONSTRAINT "sales_sheet_designs_updated_by_fkey"
  FOREIGN KEY ("updated_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
