-- 現地調査「巡回なしで撮影」権限 (field_survey:quick_capture) の初期付与。
--
-- DDL は一切無い (template_permissions.resource / action は素の String 列で
-- enum ではないため、新しい権限を増やしてもスキーマ変更は不要)。
-- データのみの additive/idempotent な backfill で、rollback してもスキーマは
-- 壊れない (コードを戻せば権限行が残るだけで無害 = 参照されなくなる)。
--
-- 付与先は「管理者用」テンプレートのみ。現地担当・事務担当には配らない
-- (経営判断: まず管理者に付け、管理画面のユーザー個別権限でアルバイトへ
--  順次 ON にしていく運用)。全員へ一括で配りたくなった場合は、この migration を
-- 変更するのではなく管理画面のテンプレート編集から付与する。
--
-- ⚠この権限は単体では成立しない。地図ページ自体が field_survey:read で保護され、
--   撮った写真の再閲覧も field_survey:read を要求するため、必ず
--   read + write とセットで配ること。
--
-- fresh DB ではテンプレート未作成のため 0 行挿入となり、その後 seed が
-- 同じ行を作る (seed 側は複合ユニークで upsert = 重複しない)。

INSERT INTO "template_permissions" ("id", "template_id", "resource", "action", "granted")
SELECT gen_random_uuid(), pt."id", 'field_survey', 'quick_capture', true
FROM "permission_templates" pt
WHERE pt."name" = '管理者用'
ON CONFLICT ("template_id", "resource", "action") DO NOTHING;
