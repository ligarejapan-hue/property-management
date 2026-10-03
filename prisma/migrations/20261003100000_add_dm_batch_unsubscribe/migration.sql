-- 宛名CSVの手紙に配信停止QR(設計 2026-10-03)。追加のみ。
-- 本番の宛名CSVの控えは 0件(2026-10-03 実測)=索引は通常の CREATE INDEX でよい。

-- 初回ダウンロード時の追跡URL(配信停止URLの頭)を控えに固定する(再ダウンロードで同じCSVを出すため)。
ALTER TABLE "dm_export_batches" ADD COLUMN "unsubscribe_base_url" TEXT;

-- 控えの行(1通)と、その送付記録を結ぶ。確定時、または確定前の停止で記録を作ったときに書く。
ALTER TABLE "dm_export_batch_items" ADD COLUMN "log_id" UUID;
CREATE INDEX "dm_export_batch_items_log_id_idx" ON "dm_export_batch_items"("log_id");
ALTER TABLE "dm_export_batch_items" ADD CONSTRAINT "dm_export_batch_items_log_id_fkey" FOREIGN KEY ("log_id") REFERENCES "property_dm_logs"("id") ON DELETE SET NULL ON UPDATE CASCADE;
