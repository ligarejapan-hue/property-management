-- 公開LPの電話ボタンのタップ計測(additive)
ALTER TABLE "dm_recipient_drafts" ADD COLUMN     "phone_tap_count" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "dm_recipient_drafts" ADD COLUMN     "phone_tap_first_at" TIMESTAMP(3);
