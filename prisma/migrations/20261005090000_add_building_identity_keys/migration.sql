-- 棟の比べる形と町丁目(設計 2026-10-04 §7・D12)。ADD のみ。値はアプリが入れる。
ALTER TABLE "buildings" ADD COLUMN "name_key" TEXT;
ALTER TABLE "buildings" ADD COLUMN "area_key" TEXT;
CREATE INDEX "buildings_area_key_name_key_idx" ON "buildings"("area_key", "name_key");
