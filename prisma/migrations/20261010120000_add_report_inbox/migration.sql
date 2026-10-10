-- 査定報告書の受け取り箱(2026-10-10)。追加のみ。
CREATE TABLE "report_inbox_items" (
    "id" UUID NOT NULL,
    "file_name" TEXT NOT NULL,
    "file_url" TEXT NOT NULL,
    "file_size" INTEGER NOT NULL,
    "original_size" INTEGER,
    "source" TEXT NOT NULL DEFAULT 'unknown',
    "building_name" TEXT,
    "room_no" TEXT,
    "address" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "uploaded_by" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "attachment_id" UUID,
    "property_id" UUID,
    "resolved_by" UUID,
    "resolved_at" TIMESTAMP(3),

    CONSTRAINT "report_inbox_items_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "report_inbox_items_status_created_at_idx" ON "report_inbox_items"("status", "created_at");
