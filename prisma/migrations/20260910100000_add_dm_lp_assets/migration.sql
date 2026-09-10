-- LP用の写真ライブラリと LP型の枠(設計 2026-09-08 §2.3)。additive のみ・バックフィルなし。
-- CreateTable
CREATE TABLE "dm_lp_assets" (
    "id" UUID NOT NULL,
    "public_id" TEXT NOT NULL,
    "storage_key" TEXT NOT NULL,
    "mime" TEXT NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "bytes" INTEGER NOT NULL,
    "label" TEXT,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "dm_lp_assets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dm_lp_variant_media" (
    "id" UUID NOT NULL,
    "lp_variant_id" UUID NOT NULL,
    "slot" TEXT NOT NULL,
    "heading" TEXT,
    "asset_id" UUID,
    "figure_kind" TEXT,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dm_lp_variant_media_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "dm_lp_assets_public_id_key" ON "dm_lp_assets"("public_id");
CREATE INDEX "dm_lp_assets_created_at_idx" ON "dm_lp_assets"("created_at");
CREATE INDEX "dm_lp_variant_media_lp_variant_id_idx" ON "dm_lp_variant_media"("lp_variant_id");
CREATE INDEX "dm_lp_variant_media_asset_id_idx" ON "dm_lp_variant_media"("asset_id");

-- AddForeignKey
ALTER TABLE "dm_lp_assets" ADD CONSTRAINT "dm_lp_assets_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "dm_lp_variant_media" ADD CONSTRAINT "dm_lp_variant_media_lp_variant_id_fkey" FOREIGN KEY ("lp_variant_id") REFERENCES "dm_lp_variants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "dm_lp_variant_media" ADD CONSTRAINT "dm_lp_variant_media_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "dm_lp_assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
