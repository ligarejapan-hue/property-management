-- Owner.corporateNumber 列追加（法人番号、13桁、nullable）。
-- 既存データは NULL のまま。Phase A では取込パイプラインへの組み込みはしない。
ALTER TABLE "owners" ADD COLUMN "corporate_number" VARCHAR(13);

-- 検索効率のため index を追加（unique 制約は入れない:
--   同一法人が別 Owner 行で複数物件を持っているケースが想定されるため。
--   論理 unique は dedup ロジック側で担保する方針）。
CREATE INDEX "owners_corporate_number_idx" ON "owners"("corporate_number");

-- owner_corporate_number field-level permission のバックフィル。
-- 既存テンプレートで owner_name の設定を踏襲する。
-- (法人番号は氏名と同等の identity 系フィールドなので、name の閲覧/編集権限と
--  整合させるのが安全。masked/hidden カスタムも自動追従する)
INSERT INTO "template_permissions" ("id", "template_id", "resource", "action", "granted")
SELECT gen_random_uuid(), tp."template_id", 'owner_corporate_number', tp."action", tp."granted"
FROM "template_permissions" tp
WHERE tp."resource" = 'owner_name'
ON CONFLICT ("template_id", "resource", "action") DO NOTHING;

-- ユーザー個別 override の引き継ぎ（owner_email migration と同じパターン）。
INSERT INTO "user_permissions" ("id", "user_id", "resource", "action", "granted")
SELECT gen_random_uuid(), up."user_id", 'owner_corporate_number', up."action", up."granted"
FROM "user_permissions" up
WHERE up."resource" = 'owner_name'
ON CONFLICT ("user_id", "resource", "action") DO NOTHING;
