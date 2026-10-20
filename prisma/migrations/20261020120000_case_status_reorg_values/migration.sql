-- 案件ステータスの整理(2026-10-20): 契約予定・契約完了を足し、並べ替えの順を整える。
-- PostgreSQL の enum は並び(=一覧の「案件ステータス順」)を後から入れ替えられないので、型を作り直す。
-- 並び = 現役12値(src/lib/property-types.ts の CASE_STATUS_VALUES)の順 → やめた値(後ろ・新規には使わない)。
-- 値の移し替え(UPDATE)は次の migration に分ける。
ALTER TYPE "CaseStatus" RENAME TO "CaseStatus_old";

CREATE TYPE "CaseStatus" AS ENUM (
  'new_case', 'contacting_owner', 'appraisal', 'negotiating', 'brokerage_obtained', 'on_sale',
  'contract_planned', 'contracted', 'sold', 'other_brokerage', 'hold', 'closed',
  'owner_contacted', 'site_checked', 'confirming_owner', 'response_received', 'dm_target', 'dm_sent',
  'waiting_registry', 'done'
);

ALTER TABLE "properties" ALTER COLUMN "case_status" DROP DEFAULT;
ALTER TABLE "properties" ALTER COLUMN "case_status" TYPE "CaseStatus" USING "case_status"::text::"CaseStatus";
ALTER TABLE "properties" ALTER COLUMN "case_status" SET DEFAULT 'new_case';

DROP TYPE "CaseStatus_old";

-- 変更履歴の「どこから」に「自動」を足す(案件ステータスの自動の切り替え)。
ALTER TYPE "ChangeSource" ADD VALUE IF NOT EXISTS 'auto';
