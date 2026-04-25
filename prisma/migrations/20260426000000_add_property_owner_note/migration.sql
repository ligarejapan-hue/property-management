-- 物件×所有者単位のメモ列を追加。
-- Owner.note (所有者本体のメモ) とは別軸。
-- 共有名義でも所有者ごと、同一 Owner が別物件にいてもメモが混ざらないように
-- PropertyOwner 側に持たせる。
-- updated_at は @updatedAt 用に default を入れて NOT NULL とする。
ALTER TABLE "property_owners"
  ADD COLUMN IF NOT EXISTS "note" TEXT,
  ADD COLUMN IF NOT EXISTS "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
