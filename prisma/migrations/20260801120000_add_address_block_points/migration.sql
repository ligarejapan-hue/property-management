-- 住所自動入力 第2弾:「番」までの精細化用テーブル(additive・既存データ無変更)。
--
-- 国土交通省「位置参照情報」街区レベル(無料公開・出典明記で利用可)の点データを
-- scripts/import-address-blocks.ts で取り込む受け皿。ピンの座標から最近傍の点を
-- 引き、「東京都杉並区西荻北3-1」のように番まで住所を自動入力する。
--   - runtime の外部送信ゼロ(ローカルDBで完結。データ未取込の地域のみ既存の
--     国土地理院フォールバック=町丁目まで)
--   - is_residential: true=街区符号(住居表示の「番」) / false=地番(住居表示未実施地域)
--   - source_version: 取込データの版(例 '24.0a')。年次更新の運用で入れ替え追跡用
--   - 取込は市区町村単位で全置換(delete→insert)のため、部分更新で新旧が混ざらない
--
-- 空のままでも既存機能(町丁目までの自動入力)は不変=デプロイだけでは挙動が変わらない。
CREATE TABLE "address_block_points" (
    "id" SERIAL NOT NULL,
    "prefecture" TEXT NOT NULL,
    "city" TEXT NOT NULL,
    "town" TEXT NOT NULL,
    "block" TEXT NOT NULL,
    "lat" DECIMAL(10,7) NOT NULL,
    "lng" DECIMAL(10,7) NOT NULL,
    "is_residential" BOOLEAN NOT NULL,
    "source_version" TEXT NOT NULL,

    CONSTRAINT "address_block_points_pkey" PRIMARY KEY ("id")
);

-- 最近傍検索は「緯度経度の bounding box で絞る→アプリ側で距離計算」の二段。
-- (lat, lng) の複合 btree で lat 範囲を索引アクセスにする(全国≒200万行想定でも
-- box 内は数百行に収まる)。
CREATE INDEX "address_block_points_lat_lng_idx" ON "address_block_points"("lat", "lng");
