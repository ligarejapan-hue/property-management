-- DM送付管理 PR-A(送付の記録)。控えバッチ2表+共有者連関3表+PropertyDmLog列追加。
-- additive・新enumなし(dm_type/method は TEXT+アプリ側allowlist)。
-- property_dm_logs.property_id は nullable 化+SET NULL(物件削除で拒否/宛先不明の
-- 履歴を道連れにしない=所有者横断の再送除外を守る)。既存データは変更しない。

-- AlterTable: property_dm_logs 列追加
ALTER TABLE "property_dm_logs" ADD COLUMN "owner_id" UUID;
ALTER TABLE "property_dm_logs" ADD COLUMN "dm_type" TEXT;
ALTER TABLE "property_dm_logs" ADD COLUMN "batch_id" UUID;
ALTER TABLE "property_dm_logs" ADD COLUMN "draft_id" UUID;
ALTER TABLE "property_dm_logs" ADD COLUMN "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- AlterTable: property_id nullable 化+FK を SET NULL へ(R49)
ALTER TABLE "property_dm_logs" ALTER COLUMN "property_id" DROP NOT NULL;
ALTER TABLE "property_dm_logs" DROP CONSTRAINT "property_dm_logs_property_id_fkey";
ALTER TABLE "property_dm_logs" ADD CONSTRAINT "property_dm_logs_property_id_fkey" FOREIGN KEY ("property_id") REFERENCES "properties"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey: owner_id
ALTER TABLE "property_dm_logs" ADD CONSTRAINT "property_dm_logs_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "owners"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateIndex: property_dm_logs
CREATE INDEX "property_dm_logs_property_id_sent_at_idx" ON "property_dm_logs"("property_id", "sent_at");
CREATE INDEX "property_dm_logs_owner_id_idx" ON "property_dm_logs"("owner_id");
CREATE INDEX "property_dm_logs_draft_id_idx" ON "property_dm_logs"("draft_id");

-- CreateTable
CREATE TABLE "dm_export_batches" (
    "id" UUID NOT NULL,
    "dm_type" TEXT NOT NULL,
    "filters" JSONB,
    "row_count" INTEGER NOT NULL,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "attempt_key" TEXT NOT NULL,
    "downloaded_at" TIMESTAMP(3),
    "csv_digest" TEXT,
    "resend_filter_applied" BOOLEAN NOT NULL DEFAULT false,
    "confirmed_at" TIMESTAMP(3),
    "confirmed_by" UUID,
    "sent_on" DATE,

    CONSTRAINT "dm_export_batches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dm_export_batch_items" (
    "id" UUID NOT NULL,
    "batch_id" UUID NOT NULL,
    "property_id" UUID,
    "owner_id" UUID,

    CONSTRAINT "dm_export_batch_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable(連関3表: 複合PK+owner_id先頭索引)
CREATE TABLE "dm_export_batch_item_owners" (
    "item_id" UUID NOT NULL,
    "owner_id" UUID NOT NULL,

    CONSTRAINT "dm_export_batch_item_owners_pkey" PRIMARY KEY ("item_id", "owner_id")
);

CREATE TABLE "property_dm_log_owners" (
    "log_id" UUID NOT NULL,
    "owner_id" UUID NOT NULL,

    CONSTRAINT "property_dm_log_owners_pkey" PRIMARY KEY ("log_id", "owner_id")
);

CREATE TABLE "dm_recipient_draft_owners" (
    "draft_id" UUID NOT NULL,
    "owner_id" UUID NOT NULL,

    CONSTRAINT "dm_recipient_draft_owners_pkey" PRIMARY KEY ("draft_id", "owner_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "dm_export_batches_created_by_attempt_key_key" ON "dm_export_batches"("created_by", "attempt_key");
CREATE INDEX "dm_export_batches_created_at_idx" ON "dm_export_batches"("created_at");
CREATE INDEX "dm_export_batch_items_batch_id_idx" ON "dm_export_batch_items"("batch_id");
CREATE INDEX "dm_export_batch_item_owners_owner_id_idx" ON "dm_export_batch_item_owners"("owner_id");
CREATE INDEX "property_dm_log_owners_owner_id_idx" ON "property_dm_log_owners"("owner_id");
CREATE INDEX "dm_recipient_draft_owners_owner_id_idx" ON "dm_recipient_draft_owners"("owner_id");

-- AddForeignKey
ALTER TABLE "dm_export_batches" ADD CONSTRAINT "dm_export_batches_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "dm_export_batch_items" ADD CONSTRAINT "dm_export_batch_items_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "dm_export_batches"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "dm_export_batch_items" ADD CONSTRAINT "dm_export_batch_items_property_id_fkey" FOREIGN KEY ("property_id") REFERENCES "properties"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "dm_export_batch_items" ADD CONSTRAINT "dm_export_batch_items_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "owners"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "dm_export_batch_item_owners" ADD CONSTRAINT "dm_export_batch_item_owners_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "dm_export_batch_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "dm_export_batch_item_owners" ADD CONSTRAINT "dm_export_batch_item_owners_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "owners"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "property_dm_log_owners" ADD CONSTRAINT "property_dm_log_owners_log_id_fkey" FOREIGN KEY ("log_id") REFERENCES "property_dm_logs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "property_dm_log_owners" ADD CONSTRAINT "property_dm_log_owners_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "owners"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "dm_recipient_draft_owners" ADD CONSTRAINT "dm_recipient_draft_owners_draft_id_fkey" FOREIGN KEY ("draft_id") REFERENCES "dm_recipient_drafts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "dm_recipient_draft_owners" ADD CONSTRAINT "dm_recipient_draft_owners_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "owners"("id") ON DELETE CASCADE ON UPDATE CASCADE;
