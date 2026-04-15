-- CreateTable
CREATE TABLE "building_photos" (
    "id" UUID NOT NULL,
    "building_id" UUID NOT NULL,
    "file_url" TEXT NOT NULL,
    "thumbnail_url" TEXT,
    "file_name" TEXT NOT NULL,
    "file_size" INTEGER NOT NULL,
    "mime_type" TEXT NOT NULL,
    "caption" TEXT,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "taken_by" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "building_photos_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "building_photos_building_id_idx" ON "building_photos"("building_id");

-- AddForeignKey
ALTER TABLE "building_photos" ADD CONSTRAINT "building_photos_building_id_fkey"
    FOREIGN KEY ("building_id") REFERENCES "buildings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "building_photos" ADD CONSTRAINT "building_photos_taken_by_fkey"
    FOREIGN KEY ("taken_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
