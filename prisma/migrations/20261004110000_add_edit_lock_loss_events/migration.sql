-- 通知 段階4c(設計書 2026-09-27-notifications-design.md §4.6・§7.2): 編集権限が外れた(N2)ことをサーバーから送る。
--
-- - edit_lock_loss_events: 編集の鍵が外れた事実(鍵の行は取り直しで ID・持ち主ごと書き換わるため、別に残す)。
--   鍵の行の ID(取るたびに新しくなる)を一意キーにして、同じ「1回の持ち時間」を二重に記録しない。
--   中身(物件名・所有者名)は入れない。時刻はアプリの時刻列と同じく UTC で持つ。
-- - notification_deliveries の種類に edit_lock_lost を足す(CHECK の付け替えだけ・行は変えない)。
--
-- 戻し方: 定期実行(timer)を先に止めてから、アプリを前の版に戻す(表は残してよい)。
--   消すときは DROP TABLE "edit_lock_loss_events"; と CHECK を元の3種類に戻す(その前に edit_lock_lost の行を消す)。

BEGIN;
-- 外部キー(users)と CHECK の付け替え(notification_deliveries)で表を短く書き込み止めにする。10秒待っても
-- 取れなければ諦める(失敗したら全部取り消し。やり直しは
--   `npx prisma migrate resolve --rolled-back 20261004110000_add_edit_lock_loss_events` → `npx prisma migrate deploy`)。
SET LOCAL lock_timeout = '10s';

CREATE TABLE "edit_lock_loss_events" (
    "id" UUID NOT NULL,
    -- 外れた鍵の行の ID
    "lock_id" UUID NOT NULL,
    -- 外れた持ち主
    "user_id" UUID NOT NULL,
    "resource_type" "EditLockResource" NOT NULL,
    "resource_id" UUID NOT NULL,
    "cause" TEXT NOT NULL,
    "occurred_at" TIMESTAMP(3) NOT NULL,
    "notified_at" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'pending',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "edit_lock_loss_events_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "edit_lock_loss_events_cause_check" CHECK ("cause" IN ('heartbeat', 'idle', 'force_released')),
    CONSTRAINT "edit_lock_loss_events_status_check" CHECK ("status" IN ('pending', 'queued', 'expired'))
);

CREATE UNIQUE INDEX "edit_lock_loss_events_lock_id_key" ON "edit_lock_loss_events"("lock_id");
CREATE INDEX "edit_lock_loss_events_status_occurred_at_idx" ON "edit_lock_loss_events"("status", "occurred_at");
CREATE INDEX "edit_lock_loss_events_created_at_idx" ON "edit_lock_loss_events"("created_at");

ALTER TABLE "edit_lock_loss_events" ADD CONSTRAINT "edit_lock_loss_events_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ⚠新しい CHECK は NOT VALID で付け(既存の行を読まない=表を押さえるのは一瞬)、確かめは COMMIT の後に
--   別に行う(VALIDATE は読み書きを止めない・@codex #473 P2)。広げるだけなので既存の行は必ず合う。
ALTER TABLE "notification_deliveries" DROP CONSTRAINT "notification_deliveries_kind_check";
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_kind_check"
  CHECK ("kind" IN ('next_action', 'inquiry_new', 'registry_job_done', 'edit_lock_lost')) NOT VALID;

COMMIT;

-- 確かめ(VALIDATE)は別のトランザクションで、押さえを待つのは10秒まで(上の SET LOCAL は COMMIT で消えるため
-- ここでも付ける・@codex #472 P2)。種類を広げるだけなので既存の行は必ず合い、失敗するのは押さえを待ち切れ
-- なかったときだけ。⚠この段だけが失敗したときは、表と制約はすでに入っている(上は COMMIT 済み)ので
-- `migrate resolve --rolled-back` は使わない。時間を置いて次の2つを順に流す:
--   1. psql で: BEGIN; SET LOCAL lock_timeout = '10s'; ALTER TABLE "notification_deliveries" VALIDATE CONSTRAINT "notification_deliveries_kind_check"; COMMIT;
--   2. `npx prisma migrate resolve --applied 20261004110000_add_edit_lock_loss_events`
BEGIN;
SET LOCAL lock_timeout = '10s';
ALTER TABLE "notification_deliveries" VALIDATE CONSTRAINT "notification_deliveries_kind_check";
COMMIT;
