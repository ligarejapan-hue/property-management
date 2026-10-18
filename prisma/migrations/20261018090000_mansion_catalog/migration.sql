-- マンション名簿(セルフイン 一都三県)と、棟がどの名簿の建物から来たかの列(2026-10-18 発注者承認)。足すだけ。
CREATE TABLE "mansion_catalog" (
    "id" UUID NOT NULL,
    "source" TEXT NOT NULL,
    "source_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "pref_code" TEXT NOT NULL,
    "stations" TEXT[],
    "built_year" INTEGER,
    "built_month" INTEGER,
    "total_floors" INTEGER,
    "basement_floors" INTEGER,
    "total_units" INTEGER,
    "structure_type" TEXT,
    "developer" TEXT,
    "management_company" TEXT,
    "raw" JSONB NOT NULL,
    "name_key" TEXT,
    "area_key" TEXT,
    "fetched_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "mansion_catalog_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "mansion_catalog_source_source_id_key" ON "mansion_catalog"("source", "source_id");
CREATE INDEX "mansion_catalog_area_key_name_key_idx" ON "mansion_catalog"("area_key", "name_key");
CREATE INDEX "mansion_catalog_name_key_idx" ON "mansion_catalog"("name_key");
CREATE INDEX "mansion_catalog_name_idx" ON "mansion_catalog"("name");

ALTER TABLE "buildings" ADD COLUMN "catalog_id" UUID;
CREATE UNIQUE INDEX "buildings_catalog_id_key" ON "buildings"("catalog_id");
ALTER TABLE "buildings" ADD CONSTRAINT "buildings_catalog_id_fkey" FOREIGN KEY ("catalog_id") REFERENCES "mansion_catalog"("id") ON DELETE SET NULL ON UPDATE CASCADE;
