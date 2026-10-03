-- 通知 段階4a(設計書 2026-09-27-notifications-design.md §7.2・§7.5): Web プッシュの登録先(端末)。
-- 表の追加だけ(既存の表は変えない)。送信の記録(notification_deliveries 等)は 4b、編集権限が外れた記録は 4c で足す。
--
-- ⚠endpoint・p256dh・auth は秘密情報。API の応答・ログ・監査ログに出さない。
-- 戻し方: アプリを前の版に戻せば使われないだけ(表は残してよい)。消すときは
--   DROP TABLE "push_subscriptions";

CREATE TABLE "push_subscriptions" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "endpoint" TEXT NOT NULL,
    "p256dh" TEXT NOT NULL,
    "auth" TEXT NOT NULL,
    -- shared = 画面を閉じてから65分で止まる(既定)/ personal = 最後のログインから30日(本人が選んだときだけ)
    "device_scope" TEXT NOT NULL DEFAULT 'shared',
    -- 今の利用者に結び付いた時刻と、結び付けごとの乱数(付け替えのたびに作り直す)
    "bound_at" TIMESTAMP(3) NOT NULL,
    "binding_id" UUID NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "last_success_at" TIMESTAMP(3),
    "failure_count" INTEGER NOT NULL DEFAULT 0,
    "revoked_at" TIMESTAMP(3),
    -- gone(中継サービスが 404/410)・logout・admin などの定型値だけ
    "revoked_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "push_subscriptions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "push_subscriptions_device_scope_check" CHECK ("device_scope" IN ('shared', 'personal'))
);

CREATE UNIQUE INDEX "push_subscriptions_endpoint_key" ON "push_subscriptions"("endpoint");
CREATE INDEX "push_subscriptions_user_id_idx" ON "push_subscriptions"("user_id");
CREATE INDEX "push_subscriptions_expires_at_idx" ON "push_subscriptions"("expires_at");

ALTER TABLE "push_subscriptions" ADD CONSTRAINT "push_subscriptions_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
