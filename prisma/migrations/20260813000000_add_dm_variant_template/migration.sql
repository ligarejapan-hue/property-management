-- 外部AI方式(プロンプト出力→貼り付け)で使う列を先に足す(expand)。
-- ⚠この migration では**書き手を作らない・バックフィルもしない**(設計 §2.4 @codex R21)。
--   列を埋めるのは PR-D2 の照合スクリプトを restart 後に流すときだけ。
--   migration 内で埋めると migrate→restart の窓で旧ルートが凍結済み型を書き換え・削除できる。
-- 既存行はすべて NULL = 従来どおりの動作。
ALTER TABLE "dm_variants" ADD COLUMN "prompt_text" TEXT;
ALTER TABLE "dm_variants" ADD COLUMN "body_template" TEXT;
ALTER TABLE "dm_variants" ADD COLUMN "template_frozen_at" TIMESTAMP(3);
