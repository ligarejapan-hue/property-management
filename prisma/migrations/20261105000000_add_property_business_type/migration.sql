-- 物件の取扱区分(仲介 / 買取再販)を入れる欄(2026-11-04 発注者)。
-- 列を足すだけ。既存の行は NULL(未定)のまま=書き換えない。値の検査はアプリ(zod)。
ALTER TABLE "properties" ADD COLUMN "business_type" TEXT;
