-- 売却DMの手紙のイラスト(設計 2026-10-05)。追加のみ。
-- 台帳(dm_scenarios)と発送の型(dm_variants)は数行~数十行=索引は通常の CREATE INDEX でよい。

-- DMの種類ごとの手紙のイラスト(LPの写真ライブラリの1枚)。
ALTER TABLE "dm_scenarios" ADD COLUMN "letter_illustration_asset_id" UUID;
CREATE INDEX "dm_scenarios_letter_illustration_asset_id_idx" ON "dm_scenarios"("letter_illustration_asset_id");
ALTER TABLE "dm_scenarios" ADD CONSTRAINT "dm_scenarios_letter_illustration_asset_id_fkey" FOREIGN KEY ("letter_illustration_asset_id") REFERENCES "dm_lp_assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 発送を作ったときに台帳から写し取ったイラスト(作成後に台帳を替えても変わらない)。
ALTER TABLE "dm_variants" ADD COLUMN "illustration_asset_id" UUID;
CREATE INDEX "dm_variants_illustration_asset_id_idx" ON "dm_variants"("illustration_asset_id");
ALTER TABLE "dm_variants" ADD CONSTRAINT "dm_variants_illustration_asset_id_fkey" FOREIGN KEY ("illustration_asset_id") REFERENCES "dm_lp_assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
