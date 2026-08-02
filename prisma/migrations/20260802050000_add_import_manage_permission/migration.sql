-- 取込ジョブの「他の人の分も操作できる」権限 import:manage を新設し、管理者テンプレートへ付与する。
--
-- 背景(2026-08-02 監査の追加是正): 直前に入れた import:read_all は画面上「全員分の閲覧」と
-- 表示されるのに、ロールバック・行の再実行/解決・失敗マーク等の**破壊的操作**まで
-- 許してしまっていた。現地調査の read_all(見るだけ) / manage(他の人の分も編集) と
-- 同じ分け方に揃える。
--
-- 反映後:
--   - import:read_all  = 他人の取込を**見られる**（変更は不可）
--   - import:manage    = 他人の取込を**操作できる**（閲覧も当然可）
--   - どちらも無い     = 自分が実行した取込だけ（従来どおり）
INSERT INTO "template_permissions" ("id", "template_id", "resource", "action", "granted")
SELECT gen_random_uuid(), t."id", 'import', 'manage', true
FROM "permission_templates" t
WHERE t."name" = '管理者用'
  AND NOT EXISTS (
    SELECT 1 FROM "template_permissions" p
    WHERE p."template_id" = t."id" AND p."resource" = 'import' AND p."action" = 'manage'
  );
