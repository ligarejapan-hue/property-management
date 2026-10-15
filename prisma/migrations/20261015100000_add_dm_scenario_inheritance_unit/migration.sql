-- DMの種類「相続（マンション）」を自動の振り分け先として1件追加(2026-10-15 発注者承認)。追加のみ。
-- 受付帳取込の区分マンションに自動で選ばれる(src/lib/sale-dm-letter/scenario-resolve.ts AUTO_KEY_BY_ROUTE_AND_TYPE)。
-- 手紙・LPの文面は空のまま=登録されるまで、区分マンションを含む売却DMは「手紙の文面がまだ登録されていない」で作れない
-- (特例の手紙がマンションへ届かないため)。止めるときは管理画面で「使わない」にすると相続に戻る。
-- 訴求(appeal/lp_appeal)は inheritance_unit=指示文に「空き家の3,000万円特例は書かない」が入る(@codex P2)。
-- auto_key=inheritance_unit の行がまだ無ければ必ず入れる(飛ばすと振り分け先が無く相続の手紙に戻るため・@codex P2)。
-- 同じ名前の種類を手で作ってあった(削除済みを除く)ときは、名前を「相続（マンション・自動）」にして入れる
-- (名前は削除済みを除いて重複不可=dm_scenarios_name_live_uniq。その名前も使われていれば一意制約で止まる=気づける)。
INSERT INTO "dm_scenarios" ("id", "name", "auto_key", "sort_order", "appeal", "lp_appeal", "updated_at")
SELECT
  gen_random_uuid(),
  CASE
    WHEN EXISTS (SELECT 1 FROM "dm_scenarios" WHERE "name" = '相続（マンション）' AND "deleted_at" IS NULL)
      THEN '相続（マンション・自動）'
    ELSE '相続（マンション）'
  END,
  'inheritance_unit', 15, 'inheritance_unit', 'inheritance_unit', CURRENT_TIMESTAMP
WHERE NOT EXISTS (
  SELECT 1 FROM "dm_scenarios" WHERE "auto_key" = 'inheritance_unit'
);
