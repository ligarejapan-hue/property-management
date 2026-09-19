-- 通知メールの送信設定(singleton)
CREATE TABLE "mail_config" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "smtp_host" TEXT,
    "smtp_port" INTEGER,
    "smtp_secure" BOOLEAN NOT NULL DEFAULT true,
    "smtp_user" TEXT,
    "smtp_pass_enc" TEXT,
    "from_address" TEXT,
    "app_base_url" TEXT,
    "inquiry_mail_detail" TEXT NOT NULL DEFAULT 'minimal',
    "updated_at" TIMESTAMP(3) NOT NULL,
    "updated_by_id" UUID,
    CONSTRAINT "mail_config_pkey" PRIMARY KEY ("id")
);

-- 利用者ごとの通知先
ALTER TABLE "users" ADD COLUMN "inquiry_notify_enabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "users" ADD COLUMN "inquiry_notify_email" TEXT;

-- 通知の取り合い時刻
ALTER TABLE "dm_inquiries" ADD COLUMN "notify_claimed_at" TIMESTAMP(3);
