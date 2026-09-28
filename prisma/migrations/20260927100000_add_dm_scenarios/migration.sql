-- 売却DM「DMの種類」台帳(設計 2026-09-27)。additive のみ。最初の2件(相続・空き家)を入れる。
-- ⚠部分一意索引は Prisma schema で表せないため、この SQL でのみ管理する。

-- CreateTable
CREATE TABLE "dm_scenarios" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "auto_key" TEXT,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "design_template" TEXT,
    "tone" TEXT,
    "length" TEXT,
    "appeal" TEXT,
    "strength" TEXT,
    "extra_instruction" TEXT,
    "letter_prompt_text" TEXT,
    "letter_body_template" TEXT,
    "lp_tone" TEXT,
    "lp_length" TEXT,
    "lp_appeal" TEXT,
    "lp_strength" TEXT,
    "lp_prompt_text" TEXT,
    "lp_raw_template" TEXT,
    "lp_headline" TEXT,
    "lp_lead" TEXT,
    "lp_body_text" TEXT,
    "lp_faq_json" JSONB,
    "deleted_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "dm_scenarios_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dm_scenario_media" (
    "id" UUID NOT NULL,
    "scenario_id" UUID NOT NULL,
    "slot" TEXT NOT NULL,
    "heading" TEXT,
    "asset_id" UUID,
    "figure_kind" TEXT,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "dm_scenario_media_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "properties" ADD COLUMN "dm_scenario_id" UUID;
ALTER TABLE "dm_campaigns" ADD COLUMN "default_scenario_id" UUID;
ALTER TABLE "dm_variants" ADD COLUMN "scenario_id" UUID;
ALTER TABLE "dm_lp_variants" ADD COLUMN "scenario_id" UUID;

-- CreateIndex
CREATE UNIQUE INDEX "dm_scenarios_auto_key_key" ON "dm_scenarios"("auto_key");
CREATE UNIQUE INDEX "dm_scenarios_name_live_uniq"
    ON "dm_scenarios"("name")
    WHERE "deleted_at" IS NULL;
CREATE INDEX "dm_scenario_media_scenario_id_idx" ON "dm_scenario_media"("scenario_id");
CREATE INDEX "dm_scenario_media_asset_id_idx" ON "dm_scenario_media"("asset_id");
CREATE INDEX "properties_dm_scenario_id_idx" ON "properties"("dm_scenario_id");
CREATE UNIQUE INDEX "dm_variants_campaign_scenario_uniq"
    ON "dm_variants"("campaign_id", "scenario_id")
    WHERE "scenario_id" IS NOT NULL;
CREATE UNIQUE INDEX "dm_lp_variants_campaign_scenario_uniq"
    ON "dm_lp_variants"("campaign_id", "scenario_id")
    WHERE "scenario_id" IS NOT NULL;

-- AddForeignKey
ALTER TABLE "dm_scenario_media" ADD CONSTRAINT "dm_scenario_media_scenario_id_fkey" FOREIGN KEY ("scenario_id") REFERENCES "dm_scenarios"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "dm_scenario_media" ADD CONSTRAINT "dm_scenario_media_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "dm_lp_assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "properties" ADD CONSTRAINT "properties_dm_scenario_id_fkey" FOREIGN KEY ("dm_scenario_id") REFERENCES "dm_scenarios"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "dm_campaigns" ADD CONSTRAINT "dm_campaigns_default_scenario_id_fkey" FOREIGN KEY ("default_scenario_id") REFERENCES "dm_scenarios"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "dm_variants" ADD CONSTRAINT "dm_variants_scenario_id_fkey" FOREIGN KEY ("scenario_id") REFERENCES "dm_scenarios"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "dm_lp_variants" ADD CONSTRAINT "dm_lp_variants_scenario_id_fkey" FOREIGN KEY ("scenario_id") REFERENCES "dm_scenarios"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 最初の2件(自動の振り分け先)
INSERT INTO "dm_scenarios" ("id", "name", "auto_key", "sort_order", "appeal", "lp_appeal", "updated_at")
VALUES (gen_random_uuid(), '相続', 'inheritance', 10, 'inheritance', 'inheritance', CURRENT_TIMESTAMP);
INSERT INTO "dm_scenarios" ("id", "name", "auto_key", "sort_order", "appeal", "lp_appeal", "updated_at")
VALUES (gen_random_uuid(), '空き家', 'vacant', 20, 'vacant', 'vacant', CURRENT_TIMESTAMP);
