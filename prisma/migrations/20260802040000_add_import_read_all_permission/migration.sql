-- 取込ジョブの「全員分を見る」権限 import:read_all を新設し、管理者テンプレートへ付与する。
--
-- 背景(2026-08-02 監査): 取込ジョブの一覧・詳細・行データ(所有者の氏名/住所/電話を
-- 含む生データ)・エラーCSV・ロールバックが `import:write` だけで通っており、
-- **他人が実行した取込の中身を誰でも横断閲覧できた**。物件側で先に入れた
-- 「担当分だけ」の考え方を取込側にも揃える。
--
-- 反映後の挙動:
--   - 管理者(この権限あり)  = 従来どおり全員分の取込を閲覧・操作できる
--   - 事務担当など(権限なし) = **自分が実行した取込だけ**(他人の分は 403 / 一覧に出ない)
-- 事務担当に全員分を見せたい場合は、管理画面で「インポート」の「全員分の閲覧」を付与する。
INSERT INTO "template_permissions" ("id", "template_id", "resource", "action", "granted")
SELECT gen_random_uuid(), t."id", 'import', 'read_all', true
FROM "permission_templates" t
WHERE t."name" = '管理者用'
  AND NOT EXISTS (
    SELECT 1 FROM "template_permissions" p
    WHERE p."template_id" = t."id" AND p."resource" = 'import' AND p."action" = 'read_all'
  );
