-- 事務担当用テンプレートへ「個人情報を含むCSV出力」(csv_export_personal:read) を付与。
--
-- 背景: 取込エラー行の CSV (GET /api/import/jobs/:jobId/export-errors) は rawData を
-- そのまま列に展開するため所有者の氏名・住所・電話が生で入るのに、`import:write`
-- だけで通り監査も無かった＝**個人情報 CSV の既定ゲートを唯一すり抜けていた**
-- (認可・PII 横断監査 2026-07-30)。同 PR でゲート
-- (csv_export:read + csv_export_personal:read) と監査を追加した。
--
-- ⚠ゲートを足すだけだと**事務担当が取込エラー行を落とせなくなる**
--   (事務担当は import を持つが csv_export_personal を持たない)。
--   発注者判断 (2026-07-30):「事務担当にも個人情報CSV権限を付ける」。
--   → **この migration とゲート追加は必ずセットで反映する**。
--
-- DDL は一切無い (template_permissions.resource / action は素の String 列で enum では
-- ないため、権限行の追加でスキーマ変更は不要)。データのみの additive/idempotent な
-- backfill で、rollback してもスキーマは壊れない (コードを戻せば権限行が残るだけ =
-- ゲートが無くなるので参照されなくなる)。
--
-- fresh DB ではテンプレート未作成のため 0 行挿入となり、その後 seed が同じ行を作る
-- (seed 側は複合ユニークで upsert = 重複しない)。
--
-- ⚠ユーザー個別の権限上書き (permission_overrides) は触らない。テンプレートを
--   使わず個別設定にしている利用者がいる場合は、管理画面から個別に付与する。

INSERT INTO "template_permissions" ("id", "template_id", "resource", "action", "granted")
SELECT gen_random_uuid(), pt."id", 'csv_export_personal', 'read', true
FROM "permission_templates" pt
WHERE pt."name" = '事務担当用'
ON CONFLICT ("template_id", "resource", "action") DO NOTHING;
