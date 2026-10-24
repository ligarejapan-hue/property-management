-- Google ドライブ連携 第2段 2a(2026-10-24・発注者承認): 接続・物件とフォルダの紐づけ・往復の台帳。
-- 足すだけ(表3つ+列1つ)。既存の表は書き換えない。

-- 添付の「ドライブへ複製した写しの file id」(NULL=まだ複製していない/対象外)。
ALTER TABLE "attachments" ADD COLUMN "drive_file_id" TEXT;

-- 接続(1行だけ)。refresh token は暗号化して保存。
CREATE TABLE "drive_connection" (
  "id" TEXT NOT NULL DEFAULT 'singleton',
  "account_email" TEXT,
  "refresh_token_enc" TEXT,
  "start_page_token" TEXT,
  "last_sync_at" TIMESTAMP(3),
  "last_error" TEXT,
  "consecutive_failures" INTEGER NOT NULL DEFAULT 0,
  "connected_by_id" UUID,
  "connected_at" TIMESTAMP(3),
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "drive_connection_pkey" PRIMARY KEY ("id")
);

-- 物件とフォルダの紐づけ(1物件=1フォルダ・1フォルダ=1物件)。
CREATE TABLE "property_drive_folders" (
  "id" UUID NOT NULL,
  "property_id" UUID NOT NULL,
  "folder_id" TEXT NOT NULL,
  "folder_name" TEXT NOT NULL,
  "folder_path" TEXT NOT NULL,
  "web_view_link" TEXT,
  "linked_by_id" UUID,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "property_drive_folders_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "property_drive_folders_property_id_key" ON "property_drive_folders"("property_id");
CREATE UNIQUE INDEX "property_drive_folders_folder_id_key" ON "property_drive_folders"("folder_id");
ALTER TABLE "property_drive_folders"
  ADD CONSTRAINT "property_drive_folders_property_id_fkey"
  FOREIGN KEY ("property_id") REFERENCES "properties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 往復の台帳(重複と往復ループの防止)。
CREATE TABLE "drive_sync_files" (
  "id" UUID NOT NULL,
  "folder_link_id" UUID NOT NULL,
  "drive_file_id" TEXT NOT NULL,
  "md5" TEXT,
  "name" TEXT NOT NULL,
  "mime_type" TEXT NOT NULL,
  "size" INTEGER,
  "modified_time" TIMESTAMP(3),
  "direction" TEXT NOT NULL,
  "attachment_id" UUID,
  "status" TEXT NOT NULL,
  "error" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "drive_sync_files_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "drive_sync_files_drive_file_id_key" ON "drive_sync_files"("drive_file_id");
CREATE INDEX "drive_sync_files_folder_link_id_created_at_idx" ON "drive_sync_files"("folder_link_id", "created_at");
ALTER TABLE "drive_sync_files"
  ADD CONSTRAINT "drive_sync_files_folder_link_id_fkey"
  FOREIGN KEY ("folder_link_id") REFERENCES "property_drive_folders"("id") ON DELETE CASCADE ON UPDATE CASCADE;
