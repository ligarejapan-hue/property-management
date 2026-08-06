-- 謄本の一括取得(PR-B・薄い版)。ジョブと項目の2テーブル。additive・新 enum なし。
-- status/certificate_type は TEXT + アプリ側 allowlist(新 Postgres enum を作らない
-- = ALTER TYPE ADD VALUE の不可逆リスクを避ける)。

-- CreateTable
CREATE TABLE "registry_fetch_jobs" (
    "id" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "certificate_type" TEXT NOT NULL,
    "requested_by_id" UUID NOT NULL,
    "idempotency_key" TEXT,
    "active_item_id" UUID,
    "paused_reason" TEXT,
    "total" INTEGER NOT NULL DEFAULT 0,
    "done" INTEGER NOT NULL DEFAULT 0,
    "failed" INTEGER NOT NULL DEFAULT 0,
    "skipped" INTEGER NOT NULL DEFAULT 0,
    "charged_but_failed" INTEGER NOT NULL DEFAULT 0,
    "charge_unknown" INTEGER NOT NULL DEFAULT 0,
    "started_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "registry_fetch_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "registry_fetch_job_items" (
    "id" UUID NOT NULL,
    "job_id" UUID NOT NULL,
    "property_id" UUID,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "error_code" TEXT,
    "attachment_id" UUID,
    "purchase_key_hash" TEXT,
    "property_fingerprint_hash" TEXT,
    "started_at" TIMESTAMP(3),
    "processed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "registry_fetch_job_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "registry_fetch_jobs_requested_by_id_idempotency_key_key" ON "registry_fetch_jobs"("requested_by_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "registry_fetch_jobs_requested_by_id_idx" ON "registry_fetch_jobs"("requested_by_id");

-- CreateIndex
CREATE INDEX "registry_fetch_jobs_status_idx" ON "registry_fetch_jobs"("status");

-- CreateIndex
CREATE INDEX "registry_fetch_job_items_job_id_status_idx" ON "registry_fetch_job_items"("job_id", "status");

-- CreateIndex
CREATE INDEX "registry_fetch_job_items_property_id_idx" ON "registry_fetch_job_items"("property_id");

-- CreateIndex
CREATE INDEX "registry_fetch_job_items_purchase_key_hash_idx" ON "registry_fetch_job_items"("purchase_key_hash");

-- AddForeignKey
ALTER TABLE "registry_fetch_jobs" ADD CONSTRAINT "registry_fetch_jobs_requested_by_id_fkey" FOREIGN KEY ("requested_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "registry_fetch_job_items" ADD CONSTRAINT "registry_fetch_job_items_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "registry_fetch_jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "registry_fetch_job_items" ADD CONSTRAINT "registry_fetch_job_items_property_id_fkey" FOREIGN KEY ("property_id") REFERENCES "properties"("id") ON DELETE SET NULL ON UPDATE CASCADE;
