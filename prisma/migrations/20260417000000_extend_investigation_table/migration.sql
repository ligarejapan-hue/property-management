-- Extend InvestigationStatus enum with fetching / failed
-- NOTE: ALTER TYPE ... ADD VALUE cannot run inside a transaction on PG < 12.
-- On PostgreSQL 15 (this project) it is safe inside a Prisma migration transaction.
ALTER TYPE "InvestigationStatus" ADD VALUE IF NOT EXISTS 'fetching';
ALTER TYPE "InvestigationStatus" ADD VALUE IF NOT EXISTS 'failed';

-- Add new columns to property_investigations
ALTER TABLE "property_investigations"
  ADD COLUMN IF NOT EXISTS "postal_code"          TEXT,
  ADD COLUMN IF NOT EXISTS "municipality_code"    TEXT,
  ADD COLUMN IF NOT EXISTS "geocode_precision"    TEXT,
  ADD COLUMN IF NOT EXISTS "fire_prevention_area" TEXT,
  ADD COLUMN IF NOT EXISTS "height_district"      TEXT,
  ADD COLUMN IF NOT EXISTS "nearby_price_summary" TEXT,
  ADD COLUMN IF NOT EXISTS "land_price_summary"   TEXT,
  ADD COLUMN IF NOT EXISTS "facility_summary"     TEXT,
  ADD COLUMN IF NOT EXISTS "field_sources_json"   JSONB,
  ADD COLUMN IF NOT EXISTS "raw_payload_json"     JSONB,
  ADD COLUMN IF NOT EXISTS "last_fetch_error"     TEXT,
  ADD COLUMN IF NOT EXISTS "fetch_version"        INTEGER NOT NULL DEFAULT 0;
