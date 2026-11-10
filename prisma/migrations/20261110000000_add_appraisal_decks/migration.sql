-- お客様向け資料「査定のご報告」(2026-11-10・additive・既存の表は変えない)
CREATE TABLE "appraisal_decks" (
  "id" UUID NOT NULL,
  "property_id" UUID NOT NULL,
  "source_attachment_id" UUID,
  "status" TEXT NOT NULL DEFAULT 'draft',
  "parser_version" INTEGER NOT NULL,
  "extracted" JSONB NOT NULL DEFAULT '{}',
  "overrides" JSONB NOT NULL DEFAULT '{}',
  "created_by" UUID,
  "updated_by" UUID,
  "confirmed_by" UUID,
  "confirmed_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "appraisal_decks_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "appraisal_decks_source_attachment_id_key" ON "appraisal_decks"("source_attachment_id");
CREATE INDEX "appraisal_decks_property_id_idx" ON "appraisal_decks"("property_id");
ALTER TABLE "appraisal_decks" ADD CONSTRAINT "appraisal_decks_property_id_fkey"
  FOREIGN KEY ("property_id") REFERENCES "properties"("id") ON DELETE CASCADE ON UPDATE CASCADE;
