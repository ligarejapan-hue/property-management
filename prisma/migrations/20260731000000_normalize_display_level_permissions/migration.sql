-- 表示レベルの重複を整理する（1項目1レベルに揃える）。
--
-- 背景: オーナー情報の表示レベル（非表示/マスク/一部表示/閲覧のみ/全表示/編集可）は
-- resource ごとに 1 つだけ効く設計だが、保存は resource × action の行を足し引きする
-- だけなので**同じ項目に複数のレベルを同時に granted にできてしまう**。解決側
-- (getOwnerDisplayConfig の resolveLevel) は**最も緩いものを採用**するため、
-- 「マスク」を付けても「全表示」の行が残っていると生値が出続ける＝設定した人の
-- 意図と実際の見え方が食い違う。同 PR で画面（排他選択）と API（保存前の検証）を
-- 直したので、既存データもここで揃える。
--
-- ⚠残すのは**いま効いているレベル**（＝最も緩いもの）。最も厳しい方を残すと、
--   例えば管理者用の備考が edit(編集可) から full に落ちて**メモが書けなくなる**等の
--   機能低下が起きる。ここでは誰の見え方も権限も変えないことを優先する
--   （＝この migration の適用前後で挙動は同一。データの表現だけを正す）。
--
-- 本番実測 (2026-07-30 時点): 対象は**管理者用テンプレートの「オーナー備考」1件のみ**
--   （edit と full が両方 granted。効いているのは edit なので full 行を削除する）。
--   個別上書き (user_permissions) に重複は無し。
--
-- DDL は無し。granted=false の行（「このレベルを外す」指定）は対象外＝触らない。
-- resource は表示レベルで制御する 8 項目に限定する（'owner' 自体の read/write/delete
-- は表示レベルではないので絶対に含めない）。

WITH ranked AS (
  SELECT
    tp."id",
    ROW_NUMBER() OVER (
      PARTITION BY tp."template_id", tp."resource"
      ORDER BY CASE tp."action"
        WHEN 'edit' THEN 1
        WHEN 'full' THEN 2
        WHEN 'read' THEN 3
        WHEN 'partial' THEN 4
        WHEN 'masked' THEN 5
        WHEN 'hidden' THEN 6
      END
    ) AS rn
  FROM "template_permissions" tp
  WHERE tp."granted"
    AND tp."action" IN ('edit', 'full', 'read', 'partial', 'masked', 'hidden')
    AND tp."resource" IN (
      'owner_name', 'owner_name_kana', 'owner_phone', 'owner_zip',
      'owner_address', 'owner_email', 'owner_note', 'owner_corporate_number'
    )
)
DELETE FROM "template_permissions"
WHERE "id" IN (SELECT "id" FROM ranked WHERE rn > 1);

WITH ranked AS (
  SELECT
    up."id",
    ROW_NUMBER() OVER (
      PARTITION BY up."user_id", up."resource"
      ORDER BY CASE up."action"
        WHEN 'edit' THEN 1
        WHEN 'full' THEN 2
        WHEN 'read' THEN 3
        WHEN 'partial' THEN 4
        WHEN 'masked' THEN 5
        WHEN 'hidden' THEN 6
      END
    ) AS rn
  FROM "user_permissions" up
  WHERE up."granted"
    AND up."action" IN ('edit', 'full', 'read', 'partial', 'masked', 'hidden')
    AND up."resource" IN (
      'owner_name', 'owner_name_kana', 'owner_phone', 'owner_zip',
      'owner_address', 'owner_email', 'owner_note', 'owner_corporate_number'
    )
)
DELETE FROM "user_permissions"
WHERE "id" IN (SELECT "id" FROM ranked WHERE rn > 1);
