-- 公開LP: アプリ内ご案内ページを実際に返した閲覧の計測(additive)
ALTER TABLE "dm_recipient_drafts" ADD COLUMN     "lp_page_first_at" TIMESTAMP(3);
ALTER TABLE "dm_recipient_drafts" ADD COLUMN     "lp_page_view_count" INTEGER NOT NULL DEFAULT 0;
