-- AlterEnum
-- Adds new PropertyType values while preserving existing 'land', 'building', 'unit', 'unknown'.
-- Existing 'building' and 'unit' records are kept as-is (displayed as "建物（旧）" / "区分（旧）").
-- No data migration is performed; existing rows are untouched.

BEGIN;

CREATE TYPE "PropertyType_new" AS ENUM (
  'land',
  'house',
  'apartment_unit',
  'apartment_building',
  'apartment_block',
  'store',
  'office',
  'warehouse',
  'factory',
  'parking',
  'other',
  'unknown',
  'building',
  'unit'
);

ALTER TABLE "properties"
  ALTER COLUMN "property_type" TYPE "PropertyType_new"
  USING ("property_type"::text::"PropertyType_new");

DROP TYPE "PropertyType";
ALTER TYPE "PropertyType_new" RENAME TO "PropertyType";

COMMIT;
