-- 決済から逆算した段取り。**足すだけ**(既存の行は書き換えない)。
--
-- - deal_schedule_items: 段取りの項目(新しい表)。行はアプリが作る(この migration では作らない)。
-- - deals.schedule_facts: 担保の判定の控え。deal_settings.schedule_template: ひな形(空=初期のひな形)。
--   どちらも DEFAULT つきの列の追加=既存の行を書き換えない。
-- - notification_deliveries の種類に deal_schedule を足す(CHECK の付け替えだけ・行は変えない)。
--
-- 戻し方: アプリを前の版に戻すだけでよい(表と列は残してよい・前の版は読まない)。
--   ⚠前の版の定期実行は deal_schedule の送信記録を送らず、取り消しもしないが害はない。30日で片付く。
--   消すときは次の順に流す(段取りの項目とひな形の編集は失う):
--     DELETE FROM "notification_deliveries" WHERE "kind" = 'deal_schedule';
--     ALTER TABLE "notification_deliveries" DROP CONSTRAINT "notification_deliveries_kind_check";
--     ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_kind_check"
--       CHECK ("kind" IN ('next_action', 'inquiry_new', 'registry_job_done', 'edit_lock_lost')) NOT VALID;
--     DROP TABLE "deal_schedule_items";
--     ALTER TABLE "deals" DROP COLUMN "schedule_facts";
--     ALTER TABLE "deal_settings" DROP COLUMN "schedule_template";

BEGIN;
-- 外部キーと CHECK の付け替えで表を短く書き込み止めにする。10秒待っても取れなければ諦める(失敗したら全部取り消し。やり直しは
--   `npx prisma migrate resolve --rolled-back 20261101100000_add_deal_schedule` → `npx prisma migrate deploy`)。
SET LOCAL lock_timeout = '10s';

ALTER TABLE "deals" ADD COLUMN "schedule_facts" JSONB NOT NULL DEFAULT '{}';
ALTER TABLE "deal_settings" ADD COLUMN "schedule_template" JSONB NOT NULL DEFAULT '[]';

CREATE TABLE "deal_schedule_items" (
    "id" UUID NOT NULL,
    "deal_id" UUID NOT NULL,
    "template_key" TEXT,
    "label" TEXT NOT NULL,
    "base" TEXT,
    "due_date" DATE NOT NULL,
    "due_manual" BOOLEAN NOT NULL DEFAULT false,
    "assignee_id" UUID,
    "assignee_manual" BOOLEAN NOT NULL DEFAULT false,
    "pre_introduction" BOOLEAN NOT NULL DEFAULT false,
    "mortgage_unknown" BOOLEAN NOT NULL DEFAULT false,
    "completion_hint" TEXT,
    "completed_at" TIMESTAMP(3),
    "auto_completed" BOOLEAN NOT NULL DEFAULT false,
    "excluded_at" TIMESTAMP(3),
    "excluded_manual" BOOLEAN NOT NULL DEFAULT false,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "deal_schedule_items_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "deal_schedule_items_deal_id_template_key_key" ON "deal_schedule_items"("deal_id", "template_key");
CREATE INDEX "deal_schedule_items_deal_id_due_date_idx" ON "deal_schedule_items"("deal_id", "due_date");
CREATE INDEX "deal_schedule_items_assignee_id_completed_at_due_date_idx" ON "deal_schedule_items"("assignee_id", "completed_at", "due_date");

ALTER TABLE "deal_schedule_items" ADD CONSTRAINT "deal_schedule_items_deal_id_fkey"
  FOREIGN KEY ("deal_id") REFERENCES "deals"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "deal_schedule_items" ADD CONSTRAINT "deal_schedule_items_assignee_id_fkey"
  FOREIGN KEY ("assignee_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ⚠新しい CHECK は NOT VALID で付け(既存の行を読まない)、確かめは COMMIT の後に別に行う。広げるだけなので既存の行は必ず合う。
ALTER TABLE "notification_deliveries" DROP CONSTRAINT "notification_deliveries_kind_check";
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_kind_check"
  CHECK ("kind" IN ('next_action', 'inquiry_new', 'registry_job_done', 'edit_lock_lost', 'deal_schedule')) NOT VALID;

COMMIT;

-- 確かめは別のトランザクションで。⚠この段だけが失敗したときは、上は COMMIT 済みなので
-- `migrate resolve --rolled-back` は使わない。時間を置いて次の2つを順に流す:
--   1. psql で: BEGIN; SET LOCAL lock_timeout = '10s'; ALTER TABLE "notification_deliveries" VALIDATE CONSTRAINT "notification_deliveries_kind_check"; COMMIT;
--   2. `npx prisma migrate resolve --applied 20261101100000_add_deal_schedule`
BEGIN;
SET LOCAL lock_timeout = '10s';
ALTER TABLE "notification_deliveries" VALIDATE CONSTRAINT "notification_deliveries_kind_check";
COMMIT;
