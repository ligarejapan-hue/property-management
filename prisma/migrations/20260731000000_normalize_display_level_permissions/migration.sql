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
--   機能低下が起きる。ここでは**誰の見え方も権限も変えない**ことを最優先にする。
--
-- 本番実測 (2026-07-30 時点): 対象は**管理者用テンプレートの「オーナー備考」1件のみ**
--   （edit と full が両方 granted。効いているのは edit なので full 行を削除する）。
--   個別上書き (user_permissions) に重複は無く、拒否上書きも 1 件も無い。
--
-- DDL は無し。resource は表示レベルで制御する 8 項目に限定する（'owner' 自体の
-- read/write/delete は表示レベルではないので絶対に含めない）。

-- 1) テンプレート側。
--
-- ⚠**拒否上書き（granted=false）がある項目は触らない**。
--   削除しようとしている下位のレベルは、「上位のレベルを外す」という個別指定の
--   **受け皿**になっていることがある。例: 管理者用に edit=true と full=true があり、
--   ある利用者が owner_note の edit を拒否している場合、その人は full に落ちて
--   見えていた。ここで full を消すと落ちる先が無くなり **hidden まで下がる**＝
--   その人だけ備考が見えなくなる。挙動不変の原則を破るので、そういう項目は
--   整理対象から外す（画面と API を排他化済みなので、新たな重複は増えない。
--   残った重複は管理画面から選び直せば解消する）。
WITH denied_levels AS (
  SELECT DISTINCT up."resource"
  FROM "user_permissions" up
  WHERE NOT up."granted"
    AND up."action" IN ('edit', 'full', 'read', 'partial', 'masked', 'hidden')
    AND up."resource" IN (
      'owner_name', 'owner_name_kana', 'owner_phone', 'owner_zip',
      'owner_address', 'owner_email', 'owner_note', 'owner_corporate_number'
    )
),
ranked AS (
  SELECT
    tp."id",
    tp."resource",
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
WHERE "id" IN (
  SELECT r."id"
  FROM ranked r
  WHERE r.rn > 1
    AND r."resource" NOT IN (SELECT d."resource" FROM denied_levels d)
);

-- 2) 個別上書き側。
--
-- こちらはガード不要。個別上書きに granted のレベルがある項目は、合成時に
-- テンプレート由来のレベルを抑止する（= 効くのは個別上書きの中で最も緩いもの）。
-- 下位を消しても最上位は残るので、効くレベルは変わらない。
-- 拒否上書き（granted=false）は WHERE で除外＝触らない。
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
