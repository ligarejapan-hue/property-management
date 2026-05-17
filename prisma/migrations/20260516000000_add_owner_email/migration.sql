-- Add email column to owners table
ALTER TABLE "owners" ADD COLUMN "email" TEXT;

-- Backfill owner_email permissions for existing templates.
-- 本番では seed を再実行しないため、ここで明示的に backfill する。
-- ただしテンプレート名で固定 full/masked を付与すると、本番管理者が事務担当用や
-- 管理者用の owner_phone を masked/hidden などにカスタムしている場合に
-- 「電話番号は制限されているのに email だけ full」という穴ができる。
-- そのため既存 template_permissions の owner_phone 設定をそのまま owner_email に
-- コピーする方式を採用する。これでカスタムテンプレートも安全に追従できる。
-- ON CONFLICT DO NOTHING で再実行・既存 owner_email エントリ尊重を担保。
-- gen_random_uuid() は PostgreSQL 13+ で組み込み。
-- 該当テンプレートに owner_phone エントリがなければ SELECT が空集合になり、INSERT も noop。
INSERT INTO "template_permissions" ("id", "template_id", "resource", "action", "granted")
SELECT gen_random_uuid(), tp."template_id", 'owner_email', tp."action", tp."granted"
FROM "template_permissions" tp
WHERE tp."resource" = 'owner_phone'
ON CONFLICT ("template_id", "resource", "action") DO NOTHING;

-- ユーザー個別 override の引き継ぎ:
-- 既存ユーザーが owner_phone に個別 override（full=false や masked=true 等）を持つ場合、
-- owner_email にも同じ action/granted をコピーする。
-- これをやらないと、電話番号を制限されているユーザーが email だけ template 既定の full で
-- 見えてしまう（resource:action 単位で merge するため override が反映されない）。
-- すでに owner_email override が存在する場合は ON CONFLICT DO NOTHING で既存を優先する。
INSERT INTO "user_permissions" ("id", "user_id", "resource", "action", "granted")
SELECT gen_random_uuid(), up."user_id", 'owner_email', up."action", up."granted"
FROM "user_permissions" up
WHERE up."resource" = 'owner_phone'
ON CONFLICT ("user_id", "resource", "action") DO NOTHING;
