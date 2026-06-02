-- =========================================================
-- S1b-1: 画面保護(screen_protection) / 謄本PDF(registry_pdf) 権限テンプレートの
--        既存DB向け idempotent backfill。
--
-- 背景: seed.ts は本番VPSの通常反映手順
--   (git pull → prisma generate → prisma migrate deploy → build → restart)
-- では再実行されないため、既存DBの正規化テンプレートに本権限が入らない。
-- 本 migration で既存DBへ idempotent に投入する（registry:auto_fetch の
-- 20260601000000 と同じ流儀）。
--
-- 方針:
--   - screen_protection:bypass は「管理者用」(admin) にのみ付与する。
--     未付与=保護対象（fail-safe）。透かし/コピー・印刷抑止の enforcement は後続 PR。
--   - registry_pdf:preview / registry_pdf:download は、既存の謄本PDF 閲覧/ダウンロード
--     挙動（property:read 保持者は全員 preview/download 可）を将来の enforcement 導入時にも
--     壊さないため、現地担当用 / 事務担当用 / 管理者用 の全3テンプレートに付与する。
--     将来、現地担当の download は admin がテンプレ編集UIで外せる。
--   - スキーマ(DDL)変更は無し（データのみ）。PII は一切含まない。
--   - gen_random_uuid() は PostgreSQL 13+ で組み込み。
--   - ON CONFLICT (template_id, resource, action) DO NOTHING で重複作成しない（idempotent）。
--   - 認可で参照される正規化テーブル template_permissions のみ対象。
--     PermissionTemplate.permissions の JSON blob は認可未使用のため触らない。
--   - fresh DB ではこの時点でテンプレ未作成のため 0 行挿入となり、その後 seed.ts が
--     テンプレート本体と本権限を upsert する（重複しない）。
-- =========================================================

-- 画面保護バイパス（管理者のみ）
INSERT INTO "template_permissions" ("id", "template_id", "resource", "action", "granted")
SELECT gen_random_uuid(), pt."id", 'screen_protection', 'bypass', true
FROM "permission_templates" pt
WHERE pt."name" = '管理者用'
ON CONFLICT ("template_id", "resource", "action") DO NOTHING;

-- 謄本PDF プレビュー（現行相当：全3テンプレート）
INSERT INTO "template_permissions" ("id", "template_id", "resource", "action", "granted")
SELECT gen_random_uuid(), pt."id", 'registry_pdf', 'preview', true
FROM "permission_templates" pt
WHERE pt."name" IN ('現地担当用', '事務担当用', '管理者用')
ON CONFLICT ("template_id", "resource", "action") DO NOTHING;

-- 謄本PDF ダウンロード（現行相当：全3テンプレート）
INSERT INTO "template_permissions" ("id", "template_id", "resource", "action", "granted")
SELECT gen_random_uuid(), pt."id", 'registry_pdf', 'download', true
FROM "permission_templates" pt
WHERE pt."name" IN ('現地担当用', '事務担当用', '管理者用')
ON CONFLICT ("template_id", "resource", "action") DO NOTHING;
