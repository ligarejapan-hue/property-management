-- 外部への依頼文のひな形。**足すだけ**(既存の行は書き換えない)。
--
-- deal_settings.request_templates: ひな形と段取りの項目の結びつき(空=初めのひな形)。DEFAULT つきの列の追加。
--
-- 戻し方: アプリを前の版に戻すだけでよい(列は残してよい・前の版は読まない)。
--   消すときは次を流す(ひな形の編集は失う):
--     ALTER TABLE "deal_settings" DROP COLUMN "request_templates";

ALTER TABLE "deal_settings" ADD COLUMN "request_templates" JSONB NOT NULL DEFAULT '[]';
