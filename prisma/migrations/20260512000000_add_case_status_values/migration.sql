-- AlterEnum: add 11 new values to CaseStatus (ADD VALUE is non-transactional in PostgreSQL).
-- BEFORE / AFTER を指定して業務上の案件状況順に近づける。
-- 既存 enum 順: new_case, site_checked, waiting_registry, dm_target, dm_sent, hold, done
-- 最終 enum 順 (active): new_case → contacting_owner → owner_contacted → site_checked
--   → confirming_owner → (waiting_registry deprecated) → dm_target → dm_sent
--   → response_received → appraisal → negotiating → brokerage_obtained → on_sale
--   → hold → other_brokerage → sold → closed → (done deprecated)

ALTER TYPE "CaseStatus" ADD VALUE IF NOT EXISTS 'contacting_owner' BEFORE 'site_checked';
ALTER TYPE "CaseStatus" ADD VALUE IF NOT EXISTS 'owner_contacted' BEFORE 'site_checked';
ALTER TYPE "CaseStatus" ADD VALUE IF NOT EXISTS 'confirming_owner' AFTER 'site_checked';

ALTER TYPE "CaseStatus" ADD VALUE IF NOT EXISTS 'response_received' BEFORE 'hold';
ALTER TYPE "CaseStatus" ADD VALUE IF NOT EXISTS 'appraisal' BEFORE 'hold';
ALTER TYPE "CaseStatus" ADD VALUE IF NOT EXISTS 'negotiating' BEFORE 'hold';
ALTER TYPE "CaseStatus" ADD VALUE IF NOT EXISTS 'brokerage_obtained' BEFORE 'hold';
ALTER TYPE "CaseStatus" ADD VALUE IF NOT EXISTS 'on_sale' BEFORE 'hold';

ALTER TYPE "CaseStatus" ADD VALUE IF NOT EXISTS 'other_brokerage' BEFORE 'done';
ALTER TYPE "CaseStatus" ADD VALUE IF NOT EXISTS 'sold' BEFORE 'done';
ALTER TYPE "CaseStatus" ADD VALUE IF NOT EXISTS 'closed' BEFORE 'done';
