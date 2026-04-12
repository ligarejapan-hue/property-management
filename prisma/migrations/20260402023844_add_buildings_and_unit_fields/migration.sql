-- CreateEnum
CREATE TYPE "OccupancyStatus" AS ENUM ('vacant', 'occupied', 'unknown');

-- AlterEnum
ALTER TYPE "PropertyType" ADD VALUE 'unit';

-- AlterTable
ALTER TABLE "properties" ADD COLUMN     "balcony_area" DECIMAL(8,2),
ADD COLUMN     "building_id" UUID,
ADD COLUMN     "exclusive_area" DECIMAL(8,2),
ADD COLUMN     "floor_no" INTEGER,
ADD COLUMN     "layout_type" TEXT,
ADD COLUMN     "management_fee" INTEGER,
ADD COLUMN     "occupancy_status" "OccupancyStatus",
ADD COLUMN     "orientation" TEXT,
ADD COLUMN     "ownership_share_note" TEXT,
ADD COLUMN     "repair_reserve_fee" INTEGER,
ADD COLUMN     "room_no" TEXT;

-- CreateTable
CREATE TABLE "buildings" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "lot_number" TEXT,
    "real_estate_number" TEXT,
    "total_floors" INTEGER,
    "total_units" INTEGER,
    "built_year" INTEGER,
    "structure_type" TEXT,
    "management_company" TEXT,
    "note" TEXT,
    "gps_lat" DECIMAL(10,7),
    "gps_lng" DECIMAL(10,7),
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "buildings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "buildings_name_idx" ON "buildings"("name");

-- CreateIndex
CREATE INDEX "buildings_address_idx" ON "buildings"("address");

-- CreateIndex
CREATE INDEX "properties_building_id_idx" ON "properties"("building_id");

-- AddForeignKey
ALTER TABLE "buildings" ADD CONSTRAINT "buildings_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "properties" ADD CONSTRAINT "properties_building_id_fkey" FOREIGN KEY ("building_id") REFERENCES "buildings"("id") ON DELETE SET NULL ON UPDATE CASCADE;
