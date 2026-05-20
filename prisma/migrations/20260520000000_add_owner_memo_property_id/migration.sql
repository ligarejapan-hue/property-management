-- OwnerMemo に任意の関連物件リンク propertyId を追加（営業履歴用途）。
-- 物件詳細→所有者タブから書かれたメモは propertyId を自動添付する設計。
-- 所有者単体メモは propertyId=null で許容する。
-- 物件が物理削除された場合は SetNull でメモ本体を残す（営業履歴を失わない）。

ALTER TABLE "owner_memos"
    ADD COLUMN "property_id" UUID;

CREATE INDEX "owner_memos_property_id_created_at_idx"
    ON "owner_memos"("property_id", "created_at");

ALTER TABLE "owner_memos"
    ADD CONSTRAINT "owner_memos_property_id_fkey"
    FOREIGN KEY ("property_id") REFERENCES "properties"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
