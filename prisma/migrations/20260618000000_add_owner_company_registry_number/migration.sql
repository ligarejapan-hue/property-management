-- Add nullable company_registry_number (会社法人等番号・12桁) column to owners (21-D Phase 3a).
-- 不動産登記の12桁番号を、国税庁の法人番号(13桁・corporate_number)とは別物として保存する。
-- nullable ADD COLUMN のみ・default/backfill なし。IF NOT EXISTS で冪等（再適用安全）。
ALTER TABLE "owners" ADD COLUMN IF NOT EXISTS "company_registry_number" VARCHAR(12);
