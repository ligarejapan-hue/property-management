-- 通知 段階4b(設計書 2026-09-27-notifications-design.md §7.2〜§7.5): Web プッシュの送信の記録。
-- 表の追加だけ(既存の表は変えない)。
--
-- - notification_deliveries      : 端末に送る1通(まとめた1通=1行)。取り合い(sending・15分)と送り直し(最大3回)。
-- - notification_delivery_refs   : 1通に含めた件。一意制約 (binding_id, kind, ref_key) で同じ端末(結び付け)に同じ件を2回含めない。
-- - notification_source_cursors  : 査定申込・謄本ジョブを定期実行が読んだ位置(サーバー側のカーソル)。
--                                  反映した時点の時刻と境界値 UUID で初期化する=反映前の申込・ジョブは送らない(§7.3)。
-- - notification_source_events   : 定期実行が初めて見つけた申込・ジョブ(送り先を決めるのは初回だけ・30日で消す)。
--
-- ⚠中身(物件名・申込者名など)は入れない。ref_key は ID と時刻・回の番号だけ。
-- ⚠Prisma の migrate deploy は1ファイルを1トランザクションで流さないため、明示する。
-- 戻し方: 定期実行(timer)を先に止めてから、アプリを前の版に戻す(表は残してよい)。消すときは
--   DROP TABLE "notification_delivery_refs"; DROP TABLE "notification_deliveries";
--   DROP TABLE "notification_source_events"; DROP TABLE "notification_source_cursors";
--   (消すと送信の記録と基準のカーソルが失われ、再び反映したときはカーソルの初期化からやり直しになる)

BEGIN;

CREATE TABLE "notification_deliveries" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "subscription_id" UUID NOT NULL,
    -- 作ったときの端末の結び付け(付け替え・再有効化のあとは送らない・§7.5)
    "binding_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "scheduled_for" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "claimed_at" TIMESTAMP(3),
    "sent_at" TIMESTAMP(3),
    -- 定型コードだけ(中継サービスの応答本文・URL は入れない)
    "last_error_code" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "notification_deliveries_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "notification_deliveries_kind_check" CHECK ("kind" IN ('next_action', 'inquiry_new', 'registry_job_done')),
    CONSTRAINT "notification_deliveries_status_check" CHECK ("status" IN ('pending', 'sending', 'sent', 'failed', 'gone', 'cancelled'))
);

CREATE INDEX "notification_deliveries_status_scheduled_for_idx" ON "notification_deliveries"("status", "scheduled_for");
CREATE INDEX "notification_deliveries_subscription_id_status_idx" ON "notification_deliveries"("subscription_id", "status");
CREATE INDEX "notification_deliveries_created_at_idx" ON "notification_deliveries"("created_at");

ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_subscription_id_fkey"
  FOREIGN KEY ("subscription_id") REFERENCES "push_subscriptions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "notification_delivery_refs" (
    "id" UUID NOT NULL,
    "delivery_id" UUID NOT NULL,
    "subscription_id" UUID NOT NULL,
    "binding_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    -- 例 next_action:<ID>:<期限Tのエポック秒>:<rev(エポックミリ秒)>:<回> / inquiry:<ID> / registry_job:<ID>
    "ref_key" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_delivery_refs_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "notification_delivery_refs_binding_id_kind_ref_key_key"
  ON "notification_delivery_refs"("binding_id", "kind", "ref_key");
CREATE INDEX "notification_delivery_refs_delivery_id_idx" ON "notification_delivery_refs"("delivery_id");

ALTER TABLE "notification_delivery_refs" ADD CONSTRAINT "notification_delivery_refs_delivery_id_fkey"
  FOREIGN KEY ("delivery_id") REFERENCES "notification_deliveries"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "notification_delivery_refs" ADD CONSTRAINT "notification_delivery_refs_subscription_id_fkey"
  FOREIGN KEY ("subscription_id") REFERENCES "push_subscriptions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "notification_source_cursors" (
    "source" TEXT NOT NULL,
    "cursor_t" TIMESTAMP(3) NOT NULL,
    "cursor_id" UUID NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "notification_source_cursors_pkey" PRIMARY KEY ("source"),
    CONSTRAINT "notification_source_cursors_source_check" CHECK ("source" IN ('inquiry', 'registry_job'))
);

-- 反映した時点(UTC の時刻で保存する=アプリの時刻列と同じ)と境界値 UUID。これより前の出来事は送らない。
INSERT INTO "notification_source_cursors" ("source", "cursor_t", "cursor_id", "updated_at") VALUES
  ('inquiry', (now() AT TIME ZONE 'UTC'), '00000000-0000-0000-0000-000000000000', (now() AT TIME ZONE 'UTC')),
  ('registry_job', (now() AT TIME ZONE 'UTC'), '00000000-0000-0000-0000-000000000000', (now() AT TIME ZONE 'UTC'));

CREATE TABLE "notification_source_events" (
    "source" TEXT NOT NULL,
    "event_id" UUID NOT NULL,
    "first_seen_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "notification_source_events_pkey" PRIMARY KEY ("source", "event_id"),
    CONSTRAINT "notification_source_events_source_check" CHECK ("source" IN ('inquiry', 'registry_job'))
);

CREATE INDEX "notification_source_events_first_seen_at_idx" ON "notification_source_events"("first_seen_at");

-- 定期実行はカーソルの5分前から読み直すので、反映の直前(10分以内)に届いた申込・完了したジョブは
-- 「見つけ済み」にしておく(反映前の出来事は送らない・§7.3)。
INSERT INTO "notification_source_events" ("source", "event_id", "first_seen_at")
  SELECT 'inquiry', "id", (now() AT TIME ZONE 'UTC') FROM "dm_inquiries"
  WHERE "submitted_at" >= (now() AT TIME ZONE 'UTC') - INTERVAL '10 minutes';
INSERT INTO "notification_source_events" ("source", "event_id", "first_seen_at")
  SELECT 'registry_job', "id", (now() AT TIME ZONE 'UTC') FROM "registry_fetch_jobs"
  WHERE "completed_at" >= (now() AT TIME ZONE 'UTC') - INTERVAL '10 minutes';

COMMIT;
