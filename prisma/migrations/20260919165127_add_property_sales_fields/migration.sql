-- AlterTable
ALTER TABLE "buildings" ADD COLUMN     "basement_floors" INTEGER,
ADD COLUMN     "built_month" INTEGER;

-- AlterTable
ALTER TABLE "properties" ADD COLUMN     "above_floors" INTEGER,
ADD COLUMN     "access" TEXT,
ADD COLUMN     "basement_floors" INTEGER,
ADD COLUMN     "built_month" INTEGER,
ADD COLUMN     "built_year" INTEGER,
ADD COLUMN     "expected_income" DECIMAL(12,1),
ADD COLUMN     "gross_yield" DECIMAL(5,2),
ADD COLUMN     "land_area" DECIMAL(10,2),
ADD COLUMN     "land_area_method" TEXT,
ADD COLUMN     "parking" TEXT,
ADD COLUMN     "sale_price" DECIMAL(12,1),
ADD COLUMN     "sale_tax_amount" DECIMAL(12,1),
ADD COLUMN     "sale_tax_type" TEXT,
ADD COLUMN     "structure_type" TEXT,
ADD COLUMN     "total_floor_area" DECIMAL(10,2),
ADD COLUMN     "total_units" INTEGER;
