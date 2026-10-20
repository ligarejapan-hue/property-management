-- 広告用のご案内ページ(DMの種類ごとの公開URL /lp/<公開名>)+Google計測(設計 2026-10-20・発注者承認)。
-- 足すだけ(列の追加・NULL可への緩和・CHECK 制約)。コードだけ戻しても動く(足した列はすべて任意)。

-- DMの種類に公開名(全種類で重複不可・空=公開しない)。
ALTER TABLE "dm_scenarios" ADD COLUMN "public_slug" TEXT;
CREATE UNIQUE INDEX "dm_scenarios_public_slug_key" ON "dm_scenarios"("public_slug");

-- 申込の表: 宛先(draft_id)を NULL 可にし、公開ページからの申込の列を足す。
ALTER TABLE "dm_inquiries" ALTER COLUMN "draft_id" DROP NOT NULL;
ALTER TABLE "dm_inquiries" ADD COLUMN "source" TEXT NOT NULL DEFAULT 'dm',
ADD COLUMN "scenario_id" UUID,
ADD COLUMN "public_slug" TEXT,
ADD COLUMN "property_address" TEXT,
ADD COLUMN "utm_source" TEXT,
ADD COLUMN "utm_medium" TEXT,
ADD COLUMN "utm_campaign" TEXT,
ADD COLUMN "utm_term" TEXT,
ADD COLUMN "utm_content" TEXT,
ADD COLUMN "gclid" TEXT;
CREATE INDEX "dm_inquiries_scenario_id_idx" ON "dm_inquiries"("scenario_id");
ALTER TABLE "dm_inquiries" ADD CONSTRAINT "dm_inquiries_scenario_id_fkey" FOREIGN KEY ("scenario_id") REFERENCES "dm_scenarios"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- 宛先か DMの種類のどちらかは必ずある(宛先も種類も無い申込を作らせない)。
ALTER TABLE "dm_inquiries" ADD CONSTRAINT "dm_inquiries_origin_check" CHECK ("draft_id" IS NOT NULL OR "scenario_id" IS NOT NULL);

-- LPの設定: Google のタグ ID と申込完了のコンバージョン ラベル(広告ページだけで使う)。
ALTER TABLE "sale_dm_config" ADD COLUMN "google_tag_id" TEXT,
ADD COLUMN "google_conv_label" TEXT;
