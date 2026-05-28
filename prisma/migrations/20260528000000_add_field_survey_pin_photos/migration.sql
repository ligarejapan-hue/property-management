-- 現地調査マップ Phase 1-H: 調査ピン写真テーブル追加。
-- 物件化前の候補地点を含む pin の写真を専用テーブルで保持する。
-- - storage_key / public URL 列は作らない。file_url は `/uploads/...` 相対パスを保持。
-- - EXIF / GPS 列は作らない (PII 蓄積回避)。
-- - soft delete 列は作らない (hard delete 方針)。
-- - pin 削除時は ON DELETE CASCADE で写真も削除する。

CREATE TABLE "field_survey_pin_photos" (
    "id" UUID NOT NULL,
    "pin_id" UUID NOT NULL,
    "file_url" TEXT NOT NULL,
    "thumbnail_url" TEXT,
    "file_name" TEXT NOT NULL,
    "file_size" INTEGER NOT NULL,
    "mime_type" TEXT NOT NULL,
    "uploaded_by_user_id" UUID NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "field_survey_pin_photos_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "field_survey_pin_photos_pin_id_idx"
    ON "field_survey_pin_photos"("pin_id");

ALTER TABLE "field_survey_pin_photos" ADD CONSTRAINT "field_survey_pin_photos_pin_id_fkey"
    FOREIGN KEY ("pin_id") REFERENCES "field_survey_pins"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "field_survey_pin_photos" ADD CONSTRAINT "field_survey_pin_photos_uploaded_by_user_id_fkey"
    FOREIGN KEY ("uploaded_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
