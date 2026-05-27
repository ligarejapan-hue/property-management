-- 現地調査マップ (Phase 1-D) の bbox 検索を高速化するための複合 index。
-- GET /api/field-survey/map/properties は通常 isArchived=false + gpsLat/gpsLng の
-- range クエリで呼ばれるため、equality (isArchived) を先頭に置く B-tree compound index
-- にして「対象行の絞り込み → 緯度範囲スキャン」を index 上で完結させる。
--
-- Prisma 命名規則に従い `properties_is_archived_gps_lat_gps_lng_idx` 名で作成。
-- 既存 `properties_is_archived_idx` とは別 index として共存する (equality 単独 query
-- が別経路で使われ続けるため drop しない)。
--
-- 本番 properties は import / edit / field-survey で常時書き込みが入る中核テーブル
-- のため、index 構築中の AccessExclusiveLock を避けるべく CONCURRENTLY を使う。
-- 制約:
--   - CONCURRENTLY は明示的な transaction block (BEGIN/COMMIT) 内で実行不可。
--     本ファイルでは BEGIN/COMMIT を一切置かず、Prisma migrate engine が statement
--     ごとに autocommit で送る挙動 (他 migration 例: 20260415100000_extend_property_type
--     のように内部で明示 BEGIN を書く設計と整合) に依存する。
--   - 失敗時は INVALID 状態の index が残ることがある。その場合は手動で
--     `DROP INDEX CONCURRENTLY "properties_is_archived_gps_lat_gps_lng_idx";` を
--     実行してから migration を再適用する。

CREATE INDEX CONCURRENTLY "properties_is_archived_gps_lat_gps_lng_idx"
  ON "properties"("is_archived", "gps_lat", "gps_lng");
