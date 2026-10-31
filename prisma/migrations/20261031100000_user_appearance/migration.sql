-- 見た目の設定(2026-10-31 発注者指示・migration 承認済み)。使う人ごとの 色テーマ・文字サイズ・レイアウト。
-- 空(NULL)なら会社の初期値(system_settings の appearance.default.*)、それも無ければ アプリの既定(自動・標準・左サイドバー)。
-- 値の検証はアプリ側(src/lib/appearance/options.ts)。選択肢を増やしても migration が要らないよう TEXT にする。
-- 列を足すだけ(既存の行は NULL=今までどおり・表の書き換えなし)。
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "theme" TEXT;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "density" TEXT;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "layout" TEXT;
