-- AlterTable
ALTER TABLE "attachments" ADD COLUMN "deleted_at" TIMESTAMP(3);

-- Backfill: 既存の soft-deleted 行に削除時刻を付与（NULL のままだと cleanup 対象外。
-- 適用時刻を入れることで、既存オーファンも本適用から90日後に段階回収される）。
UPDATE "attachments" SET "deleted_at" = NOW() WHERE "is_deleted" = true AND "deleted_at" IS NULL;

-- CreateIndex
CREATE INDEX "attachments_is_deleted_type_deleted_at_idx" ON "attachments" ("is_deleted", "type", "deleted_at");
