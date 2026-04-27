-- AlterTable: PropertyPhoto に caption / is_primary を追加
ALTER TABLE "property_photos" ADD COLUMN "caption" TEXT;
ALTER TABLE "property_photos" ADD COLUMN "is_primary" BOOLEAN NOT NULL DEFAULT false;
