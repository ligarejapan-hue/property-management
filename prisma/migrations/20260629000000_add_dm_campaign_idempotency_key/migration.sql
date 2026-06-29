-- AlterTable
ALTER TABLE "dm_campaigns" ADD COLUMN "idempotency_key" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "dm_campaigns_idempotency_key_key" ON "dm_campaigns"("idempotency_key");
