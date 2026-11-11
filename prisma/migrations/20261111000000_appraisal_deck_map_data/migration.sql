-- 「査定のご報告」の周辺地図のデータ(2026-11-11・additive・null 可=既存の行はそのまま)
ALTER TABLE "appraisal_decks" ADD COLUMN "map_data" JSONB;
