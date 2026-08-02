-- 住所自動入力 第3弾:「号」までの精細化用テーブル(additive・既存データ無変更)。
--
-- デジタル庁「アドレス・ベース・レジストリ」住居表示-住居マスター位置参照拡張
-- (無料公開・全47都道府県整備済み)を scripts/import-address-residences.ts で取り込む
-- 受け皿。住居番号(号)1つごとの代表点座標を持ち、ピンの最近傍から
-- 「東京都杉並区西荻北3-19-4」のように**号まで**住所を自動入力する。
--   - runtime の外部送信ゼロ(ローカルDBで完結)。ヒットしない場合は既存の
--     街区(番まで)→国土地理院(町丁目まで)へ順にフォールバック
--   - chome: 算用数字の丁目(丁目なし町字は空文字) / block=番 / rsdt=号(枝番は "4-2" 形)
--   - source_version: 取込データの版(取込日等)。年次更新の運用で入れ替え追跡用
--   - 取込は市区町村単位で全置換(delete→insert)・都道府県単位の1txで原子化
--
-- 空のままでも既存機能は不変=デプロイだけでは挙動が変わらない。
CREATE TABLE "address_residence_points" (
    "id" SERIAL NOT NULL,
    "prefecture" TEXT NOT NULL,
    "city" TEXT NOT NULL,
    "town" TEXT NOT NULL,
    "chome" TEXT NOT NULL,
    "block" TEXT NOT NULL,
    "rsdt" TEXT NOT NULL,
    "lat" DECIMAL(10,7) NOT NULL,
    "lng" DECIMAL(10,7) NOT NULL,
    "source_version" TEXT NOT NULL,

    CONSTRAINT "address_residence_points_pkey" PRIMARY KEY ("id")
);

-- 最近傍検索(bounding box)用と、取込(市区町村単位の全置換)・版掃除の述語用。
CREATE INDEX "address_residence_points_lat_lng_idx" ON "address_residence_points"("lat", "lng");
CREATE INDEX "address_residence_points_prefecture_city_idx" ON "address_residence_points"("prefecture", "city");
