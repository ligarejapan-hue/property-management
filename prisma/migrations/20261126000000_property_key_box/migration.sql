-- キーボックスの設置場所・解除番号(2026-11-26 発注者「反響のところで業者さんに伝えられるように」)。
-- 足すだけ・NULL を許す(今の行はそのまま=未入力)。

-- AlterTable
ALTER TABLE "properties" ADD COLUMN "key_box_location" TEXT, ADD COLUMN "key_box_code" TEXT;
