-- 物件名(マンション名・アパート名)。任意入力・集合住宅の種別でのみ使う。
-- 追加のみ(nullable)なので既存行・既存コードに影響しない。
ALTER TABLE "properties" ADD COLUMN "building_name" TEXT;
