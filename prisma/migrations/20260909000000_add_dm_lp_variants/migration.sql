-- 売却DM LP型(設計 2026-09-08 §2.1/§2.9)。additive のみ。既存行の lp_variant_id は NULL=従来どおり。
-- CreateTable
CREATE TABLE "dm_lp_variants" (
    "id" UUID NOT NULL,
    "campaign_id" UUID NOT NULL,
    "label" TEXT NOT NULL,
    "tone" TEXT NOT NULL,
    "length" TEXT NOT NULL,
    "appeal" TEXT NOT NULL,
    "strength" TEXT NOT NULL,
    "prompt_text" TEXT,
    "raw_template" TEXT,
    "headline" TEXT,
    "lead" TEXT,
    "body_text" TEXT,
    "faq_json" JSONB,
    "template_frozen_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "dm_lp_variants_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "dm_recipient_drafts" ADD COLUMN "lp_variant_id" UUID;

-- CreateIndex
CREATE INDEX "dm_lp_variants_campaign_id_idx" ON "dm_lp_variants"("campaign_id");
CREATE INDEX "dm_recipient_drafts_lp_variant_id_idx" ON "dm_recipient_drafts"("lp_variant_id");

-- AddForeignKey
ALTER TABLE "dm_lp_variants" ADD CONSTRAINT "dm_lp_variants_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "dm_campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "dm_recipient_drafts" ADD CONSTRAINT "dm_recipient_drafts_lp_variant_id_fkey" FOREIGN KEY ("lp_variant_id") REFERENCES "dm_lp_variants"("id") ON DELETE SET NULL ON UPDATE CASCADE;
