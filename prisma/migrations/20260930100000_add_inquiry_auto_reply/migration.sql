-- 申込者への受付メール(自動返信)。スイッチは初期OFF=反映しただけでは何も送らない。
ALTER TABLE "mail_config" ADD COLUMN "inquiry_auto_reply_enabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "mail_config" ADD COLUMN "inquiry_auto_reply_subject" TEXT;
ALTER TABLE "mail_config" ADD COLUMN "inquiry_auto_reply_body" TEXT;

-- 申込ごとの送信状態。既定 'none'=過去の申込には送らない(送るのは申込の直後の1回だけ)。
ALTER TABLE "dm_inquiries" ADD COLUMN "auto_reply_status" TEXT NOT NULL DEFAULT 'none';
