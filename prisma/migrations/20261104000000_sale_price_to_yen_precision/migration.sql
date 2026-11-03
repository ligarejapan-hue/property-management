-- 物件の販売価格・うち消費税を1円まで持てるようにする(2026-11-03 発注者承認)。
-- 単位は今までどおり万円。小数1桁(1,000円単位)→4桁(1円単位)。整数部は11桁のまま=今ある値はそのまま入る(書き換えなし)。
-- 2列を1文で変える=表の作り直しは1回で済む。
ALTER TABLE "properties"
  ALTER COLUMN "sale_price" SET DATA TYPE DECIMAL(15,4),
  ALTER COLUMN "sale_tax_amount" SET DATA TYPE DECIMAL(15,4);
