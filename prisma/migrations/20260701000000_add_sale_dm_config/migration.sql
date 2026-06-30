-- 売却促進DM の設定保管(管理画面から編集・1行 id="singleton")。
-- APIキーは暗号化(*_enc)して保存・非秘匿項目は平文。未設定項目は env フォールバック。
-- 新規テーブルのみ・既存への影響なし・backfill 不要。
CREATE TABLE "sale_dm_config" (
    "id" TEXT NOT NULL,
    "provider" TEXT,
    "model" TEXT,
    "tracking_base_url" TEXT,
    "lp_url" TEXT,
    "sender_name" TEXT,
    "sender_contact" TEXT,
    "anthropic_api_key_enc" TEXT,
    "openai_api_key_enc" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "updated_by_id" UUID,

    CONSTRAINT "sale_dm_config_pkey" PRIMARY KEY ("id")
);
