-- 物件の2筆目以降の土地・2棟目以降の建物(列を足すだけ・今ある物件は空の一覧)。
ALTER TABLE "properties" ADD COLUMN "extra_parcels" JSONB NOT NULL DEFAULT '[]';
