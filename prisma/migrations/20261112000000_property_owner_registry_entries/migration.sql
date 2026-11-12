-- 登記上の記載(2026-11-12 発注者決定・additive・既存の表は変えない)
-- 所有者事項に載っている行(住所・持分)を、物件×所有者のつながりごとに行の順で持つ。
-- 同じ人が住所違い・持分ごとに何行も載るとき、所有者は1人のまま内訳を捨てない。
-- 戻すとき: この表を DROP するだけ(ほかの表は変えていない)。
CREATE TABLE "property_owner_registry_entries" (
  "id" UUID NOT NULL,
  "property_owner_id" UUID NOT NULL,
  "position" INTEGER NOT NULL,
  "address" TEXT,
  "share_num" INTEGER,
  "share_den" INTEGER,
  "source_attachment_id" UUID,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "property_owner_registry_entries_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "property_owner_registry_entries_property_owner_id_position_key"
  ON "property_owner_registry_entries"("property_owner_id", "position");
ALTER TABLE "property_owner_registry_entries" ADD CONSTRAINT "property_owner_registry_entries_property_owner_id_fkey"
  FOREIGN KEY ("property_owner_id") REFERENCES "property_owners"("id") ON DELETE CASCADE ON UPDATE CASCADE;
