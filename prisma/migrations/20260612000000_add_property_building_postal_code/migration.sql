-- Add nullable postal_code column to properties and buildings (21-C PR-1).
-- DM 送付に郵便番号が必要なため保存先を追加。nullable ADD COLUMN のみ・default/backfill なし。
-- IF NOT EXISTS で冪等（再適用安全）。
ALTER TABLE "properties" ADD COLUMN IF NOT EXISTS "postal_code" TEXT;
ALTER TABLE "buildings" ADD COLUMN IF NOT EXISTS "postal_code" TEXT;
