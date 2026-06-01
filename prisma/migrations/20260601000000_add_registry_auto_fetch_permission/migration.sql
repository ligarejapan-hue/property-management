-- =========================================================
-- registry:auto_fetch 権限テンプレートエントリのバックフィル
--
-- 背景: seed.ts は本番VPSの通常反映手順
--   (git pull → prisma generate → prisma migrate deploy → build → restart)
-- では再実行されないため、既存DBの「管理者用」テンプレートに registry:auto_fetch が
-- 入らず、将来 hasPermission(perms, "registry", "auto_fetch") を使うAPIで admin が
-- 拒否される恐れがある。本 migration で既存DBへ idempotent に投入する。
--
-- 方針:
--   - 「管理者用」(admin) テンプレートにのみ resource=registry / action=auto_fetch /
--     granted=true を 1 件追加する（office_staff / field_staff には付与しない）。
--   - ON CONFLICT (template_id, resource, action) DO NOTHING で重複作成しない（idempotent）。
--   - gen_random_uuid() は PostgreSQL 13+ で組み込み。
--   - スキーマ(DDL)変更は無し（データのみ）。PII は一切含まない。
--   - 認可で参照される正規化テーブル template_permissions のみ対象。
--     PermissionTemplate.permissions の JSON blob は認可未使用のため触らない
--     （field_survey backfill 20260526000000 と同じ流儀）。
--   - fresh DB ではこの時点で「管理者用」が未作成のため 0 行挿入となり、その後
--     seed.ts がテンプレート本体と本権限を作成する（seed の upsert で重複しない）。
-- =========================================================

INSERT INTO "template_permissions" ("id", "template_id", "resource", "action", "granted")
SELECT gen_random_uuid(), pt."id", 'registry', 'auto_fetch', true
FROM "permission_templates" pt
WHERE pt."name" = '管理者用'
ON CONFLICT ("template_id", "resource", "action") DO NOTHING;
