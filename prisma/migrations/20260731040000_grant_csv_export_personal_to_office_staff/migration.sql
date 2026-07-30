-- 事務担当用テンプレートへ「個人情報を含むCSV出力」(csv_export_personal:read) を付与。
--
-- ⚠**発注者判断 2026-07-31:「全件CSVも事務担当に許可する」**
--
-- 経緯: 直前の反映（#340）では、取込エラー行 CSV を落とせるようにするために
-- **専用権限 `import_error_csv` だけ**を付与した。共有の `csv_export_personal` を
-- 配ると、取込エラー行にとどまらず下記まで一度に解禁されるため、ご依頼より広い
-- 権限拡大になるという理由だった:
--   - /api/properties/export             (全物件CSV・所有者名入り)
--   - /api/properties/dm-export          (DM差込CSV)
--   - /api/properties/property-dm-export (物件宛DM CSV)
-- 今回、その範囲を含めて許可する判断が示されたので付与する。
-- （事務担当は property:read / owner:read / csv_export:read を既に持つため、
--   この1行で上記3経路が有効になる。物件一覧に出力ボタンも出る。）
--
-- ⚠これは**個人情報の持ち出し範囲を広げる変更**である。ただし
--   - 3経路とも `csv_export` + `csv_export_personal` の二重ゲートを通る
--   - 出力は全経路で監査ログに残る（誰がいつ何件出したか）
--   - 表示レベル（マスク等）は CSV 側にも適用される
--   ため、無記録の持ち出しにはならない。
--
-- ⚠`import_error_csv` は**消さない**。この権限があれば csv_export_personal でも
--   通るので事務担当には冗長だが、「取込エラー行だけ落とせる」という**より狭い
--   付与**（アルバイト等）に必要なため残す。
--
-- DDL は一切無い（template_permissions.resource / action は素の String 列）。
-- データのみの additive/idempotent な付与で、rollback してもスキーマは壊れない。
-- fresh DB ではテンプレート未作成のため 0 行挿入となり、その後 seed が同じ行を作る。
-- ⚠ユーザー個別の権限上書き (user_permissions) は触らない。

INSERT INTO "template_permissions" ("id", "template_id", "resource", "action", "granted")
SELECT gen_random_uuid(), pt."id", 'csv_export_personal', 'read', true
FROM "permission_templates" pt
WHERE pt."name" = '事務担当用'
ON CONFLICT ("template_id", "resource", "action") DO NOTHING;
