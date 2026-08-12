-- 所有者の「現住所」を追加する。
-- 既存の zip/address は「登記上」の意味のまま据え置く(設計 §2)。
-- additive のみ・バックフィル無し。既存行はすべて NULL = 現住所未設定 = 従来どおりの動作。
ALTER TABLE "owners" ADD COLUMN "current_zip" TEXT;
ALTER TABLE "owners" ADD COLUMN "current_address" TEXT;
