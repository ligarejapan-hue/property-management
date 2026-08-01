-- 取込・掃除の述語用 index(additive)。
-- 市区町村単位の全置換 deleteMany(prefecture, city) と、版更新時の旧版残存の
-- count/delete(prefecture, source_version の prefix として prefecture) が
-- 全表スキャンにならないようにする(全国≒200万行・年次の都道府県一括取込でも
-- tx タイムアウトに収まる)。検索用の (lat, lng) index は初回 migration 参照。
CREATE INDEX "address_block_points_prefecture_city_idx" ON "address_block_points"("prefecture", "city");
