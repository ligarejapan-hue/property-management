-- CreateEnum
CREATE TYPE "InvestigationStatus" AS ENUM ('draft', 'needs_review', 'confirmed');

-- CreateTable: property_investigations (one-to-one with properties)
CREATE TABLE "property_investigations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "property_id" UUID NOT NULL,
    "status" "InvestigationStatus" NOT NULL DEFAULT 'draft',
    "source_address" TEXT,
    "normalized_address" TEXT,
    "land_lot_number" TEXT,
    "latitude" DECIMAL(10,7),
    "longitude" DECIMAL(10,7),
    "zoning_district" TEXT,
    "building_coverage_ratio" DECIMAL(5,2),
    "floor_area_ratio" DECIMAL(5,2),
    "hazard_summary" TEXT,
    "road_summary" TEXT,
    "infrastructure_summary" TEXT,
    "auto_fetch_summary" TEXT,
    "source_summary" TEXT,
    "fetched_at" TIMESTAMP(3),
    "confirmed_at" TIMESTAMP(3),
    "confirmed_by" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "property_investigations_pkey" PRIMARY KEY ("id")
);

-- CreateTable: property_investigation_audit_logs (action log)
CREATE TABLE "property_investigation_audit_logs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "property_id" UUID NOT NULL,
    "investigation_id" UUID,
    "action" TEXT NOT NULL,
    "before_json" JSONB,
    "after_json" JSONB,
    "note" TEXT,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "property_investigation_audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "property_investigations_property_id_key" ON "property_investigations"("property_id");
CREATE INDEX "property_investigation_audit_logs_property_id_created_at_idx" ON "property_investigation_audit_logs"("property_id", "created_at");

-- AddForeignKey
ALTER TABLE "property_investigations" ADD CONSTRAINT "property_investigations_property_id_fkey"
    FOREIGN KEY ("property_id") REFERENCES "properties"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "property_investigations" ADD CONSTRAINT "property_investigations_confirmed_by_fkey"
    FOREIGN KEY ("confirmed_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "property_investigation_audit_logs" ADD CONSTRAINT "property_investigation_audit_logs_property_id_fkey"
    FOREIGN KEY ("property_id") REFERENCES "properties"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "property_investigation_audit_logs" ADD CONSTRAINT "property_investigation_audit_logs_investigation_id_fkey"
    FOREIGN KEY ("investigation_id") REFERENCES "property_investigations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "property_investigation_audit_logs" ADD CONSTRAINT "property_investigation_audit_logs_created_by_fkey"
    FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
