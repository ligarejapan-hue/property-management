-- ドライブとの往復の台帳を、紐づけを外しても残す(同じ物件に付け直したとき、受け取り箱・写真を取り込み直さない)。
-- 足す・緩めるだけ(列の追加・NOT NULL を外す・外部キーの消え方を CASCADE → SET NULL)。行は消さない。

ALTER TABLE "drive_sync_files" ADD COLUMN "property_id" UUID;

-- 今ある行に、書いたときの物件を入れる(紐づけから引く)
UPDATE "drive_sync_files" AS f
SET "property_id" = l."property_id"
FROM "property_drive_folders" AS l
WHERE f."folder_link_id" = l."id" AND f."property_id" IS NULL;

ALTER TABLE "drive_sync_files" ALTER COLUMN "folder_link_id" DROP NOT NULL;

ALTER TABLE "drive_sync_files" DROP CONSTRAINT "drive_sync_files_folder_link_id_fkey";
ALTER TABLE "drive_sync_files"
  ADD CONSTRAINT "drive_sync_files_folder_link_id_fkey"
  FOREIGN KEY ("folder_link_id") REFERENCES "property_drive_folders"("id") ON DELETE SET NULL ON UPDATE CASCADE;
