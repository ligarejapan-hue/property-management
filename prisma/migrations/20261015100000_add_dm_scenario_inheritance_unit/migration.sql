-- DMの種類「相続（マンション）」を自動の振り分け先として1件追加(2026-10-15 発注者承認)。追加のみ。
-- 受付帳取込の区分マンションに自動で選ばれる(src/lib/sale-dm-letter/scenario-resolve.ts AUTO_KEY_BY_ROUTE_AND_TYPE)。
-- 手紙・LPの文面は空のまま=登録されるまで、区分マンションを含む売却DMは「手紙の文面がまだ登録されていない」で作れない
-- (特例の手紙がマンションへ届かないため)。止めるときは管理画面で「使わない」にすると相続に戻る。
-- 同じ auto_key か同じ名前(削除済みを除く)の行がすでにあれば入れない(手で作った行とぶつけない)。
INSERT INTO "dm_scenarios" ("id", "name", "auto_key", "sort_order", "appeal", "lp_appeal", "updated_at")
SELECT gen_random_uuid(), '相続（マンション）', 'inheritance_unit', 15, 'inheritance', 'inheritance', CURRENT_TIMESTAMP
WHERE NOT EXISTS (
  SELECT 1 FROM "dm_scenarios"
  WHERE "auto_key" = 'inheritance_unit' OR ("name" = '相続（マンション）' AND "deleted_at" IS NULL)
);
