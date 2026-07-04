-- AlterEnum: 所有者事項PDF一括取込(registry_pdf_bulk)のジョブ種別と、
-- 非同期処理の未処理行を表す pending 行状態を追加する。
-- NOTE: ALTER TYPE ... ADD VALUE cannot run inside a transaction on PG < 12.
ALTER TYPE "ImportJobType" ADD VALUE IF NOT EXISTS 'registry_pdf_bulk';
ALTER TYPE "ImportRowStatus" ADD VALUE IF NOT EXISTS 'pending';
