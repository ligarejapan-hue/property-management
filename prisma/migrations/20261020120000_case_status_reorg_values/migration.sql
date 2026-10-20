-- 案件ステータスの整理(2026-10-20): 契約予定・契約完了を足し、並べ替えの順を整える。
-- PostgreSQL の enum は並び(=一覧の「案件ステータス順」)を後から入れ替えられないので、型を作り直す。
-- 並び = 現役12値(src/lib/property-types.ts の CASE_STATUS_VALUES)の順 → やめた値(後ろ・新規には使わない)。
-- 値の移し替え(UPDATE)は次の migration に分ける。
--
-- ⚠物件の表を書き直す間(本番 約13万件・101MB で数秒の見込み。手元 13.1万件で 1.3秒)は、物件の読み書きが待たされる
--   (@codex #538 R7)。そこで:
--   - 全体を1つのトランザクションにする=途中で止まっても型の名前の付け替えなどが中途半端に残らない
--   - 表を押さえられるまでの待ちは10秒まで(lock_timeout)=長い問い合わせの後ろで全員を待たせ続けない。
--     10秒で押さえられなければ migration は失敗して何も変わらない(旧コードのまま動き続ける)→ 空いている時間に流し直す
--   旧コードの接続はつないだままでよい(名前なしの問い合わせ=型の作り直しの後もそのまま通ることを手元で確認)。
BEGIN;
SET LOCAL lock_timeout = '10s';

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

-- 変更履歴の「どこから」に「自動」を足す(案件ステータスの自動の切り替え)。この migration の中では使わない。
ALTER TYPE "ChangeSource" ADD VALUE IF NOT EXISTS 'auto';

COMMIT;
