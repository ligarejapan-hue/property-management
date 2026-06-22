-- CreateEnum
CREATE TYPE "DmCampaignStatus" AS ENUM ('draft', 'ready', 'sent', 'closed');

-- CreateEnum
CREATE TYPE "DmDraftStatus" AS ENUM ('draft', 'confirmed', 'sent');

-- CreateEnum
CREATE TYPE "DmOutcome" AS ENUM ('none', 'inquiry');

-- CreateEnum
CREATE TYPE "DmDeliveryStatus" AS ENUM ('unknown', 'delivered', 'returned_undeliverable', 'returned_other');

-- AlterTable
ALTER TABLE "properties" ADD COLUMN     "dm_undeliverable_at" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "dm_campaigns" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "status" "DmCampaignStatus" NOT NULL DEFAULT 'draft',
    "filter_snapshot" JSONB,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "dm_campaigns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dm_variants" (
    "id" UUID NOT NULL,
    "campaign_id" UUID NOT NULL,
    "label" TEXT NOT NULL,
    "design_template" TEXT NOT NULL,
    "tone" TEXT NOT NULL,
    "length" TEXT NOT NULL,
    "appeal" TEXT NOT NULL,
    "strength" TEXT NOT NULL,
    "extra_instruction" TEXT,

    CONSTRAINT "dm_variants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dm_recipient_drafts" (
    "id" UUID NOT NULL,
    "campaign_id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "representative_owner_id" UUID,
    "variant_id" UUID NOT NULL,
    "override_json" JSONB,
    "recipient_name" TEXT NOT NULL,
    "recipient_zip" TEXT,
    "recipient_address" TEXT,
    "honorific" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "model" TEXT,
    "status" "DmDraftStatus" NOT NULL DEFAULT 'draft',
    "sent_at" TIMESTAMP(3),
    "delivery_status" "DmDeliveryStatus" NOT NULL DEFAULT 'unknown',
    "returned_at" TIMESTAMP(3),
    "tracking_token" TEXT NOT NULL,
    "lp_first_access_at" TIMESTAMP(3),
    "lp_access_count" INTEGER NOT NULL DEFAULT 0,
    "phone_inquiry_at" TIMESTAMP(3),
    "outcome" "DmOutcome" NOT NULL DEFAULT 'none',
    "outcome_note" TEXT,
    "generated_by" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "confirmed_at" TIMESTAMP(3),

    CONSTRAINT "dm_recipient_drafts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "dm_recipient_drafts_tracking_token_key" ON "dm_recipient_drafts"("tracking_token");

-- CreateIndex
CREATE INDEX "dm_recipient_drafts_campaign_id_idx" ON "dm_recipient_drafts"("campaign_id");

-- CreateIndex
CREATE INDEX "dm_recipient_drafts_property_id_idx" ON "dm_recipient_drafts"("property_id");

-- AddForeignKey
ALTER TABLE "dm_campaigns" ADD CONSTRAINT "dm_campaigns_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dm_variants" ADD CONSTRAINT "dm_variants_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "dm_campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dm_recipient_drafts" ADD CONSTRAINT "dm_recipient_drafts_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "dm_campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dm_recipient_drafts" ADD CONSTRAINT "dm_recipient_drafts_variant_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "dm_variants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dm_recipient_drafts" ADD CONSTRAINT "dm_recipient_drafts_property_id_fkey" FOREIGN KEY ("property_id") REFERENCES "properties"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dm_recipient_drafts" ADD CONSTRAINT "dm_recipient_drafts_generated_by_fkey" FOREIGN KEY ("generated_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
