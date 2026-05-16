-- Add email column to owners table
ALTER TABLE "owners" ADD COLUMN "email" TEXT;

-- Backfill owner_email permissions for existing seeded templates.
-- 本番では seed を再実行しないため、ここで明示的に backfill する。
-- ON CONFLICT DO NOTHING で再実行・別環境への二重適用を安全にする。
-- gen_random_uuid() は PostgreSQL 13+ で組み込み。
-- 該当テンプレートが存在しない環境では SELECT が空集合になり、INSERT も noop。

-- 現地担当用 (field_staff): owner_email masked
INSERT INTO "template_permissions" ("id", "template_id", "resource", "action", "granted")
SELECT gen_random_uuid(), t.id, 'owner_email', 'masked', true
FROM "permission_templates" t
WHERE t.name = '現地担当用'
ON CONFLICT ("template_id", "resource", "action") DO NOTHING;

-- 事務担当用 (office_staff): owner_email full
INSERT INTO "template_permissions" ("id", "template_id", "resource", "action", "granted")
SELECT gen_random_uuid(), t.id, 'owner_email', 'full', true
FROM "permission_templates" t
WHERE t.name = '事務担当用'
ON CONFLICT ("template_id", "resource", "action") DO NOTHING;

-- 管理者用 (admin): owner_email full
INSERT INTO "template_permissions" ("id", "template_id", "resource", "action", "granted")
SELECT gen_random_uuid(), t.id, 'owner_email', 'full', true
FROM "permission_templates" t
WHERE t.name = '管理者用'
ON CONFLICT ("template_id", "resource", "action") DO NOTHING;
