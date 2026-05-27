-- 現地調査マップ (Phase 1-D) の bbox 検索を高速化するための複合 index。
-- GET /api/field-survey/map/properties は通常 isArchived=false + gpsLat/gpsLng の
-- range クエリで呼ばれるため、equality (isArchived) を先頭に置く B-tree compound index
-- にして「対象行の絞り込み → 緯度範囲スキャン」を index 上で完結させる。
--
-- Prisma 命名規則に従い `properties_is_archived_gps_lat_gps_lng_idx` 名で作成。
-- 既存 `properties_is_archived_idx` とは別 index として共存する (equality 単独 query
-- が別経路で使われ続けるため drop しない)。

CREATE INDEX "properties_is_archived_gps_lat_gps_lng_idx"
  ON "properties"("is_archived", "gps_lat", "gps_lng");
