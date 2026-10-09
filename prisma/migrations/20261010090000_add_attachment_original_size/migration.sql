-- 大きいPDFの自動圧縮(2026-10-10)。追加のみ。
-- 自動で縮めた添付だけ、圧縮前の大きさ(bytes)を持つ。縮めていなければ NULL。
ALTER TABLE "attachments" ADD COLUMN "original_size" INTEGER;
