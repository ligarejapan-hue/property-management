-- 区分マンションの専有面積を2つに分ける(2026-10-24 発注者決定)。
--   exclusive_area          = 壁芯(パンフレットの面積)。資金計画表・事業計画書の税金の計算もこの値。
--   exclusive_area_registry = 登記簿の面積(内法)。
ALTER TABLE "properties" ADD COLUMN "exclusive_area_registry" DECIMAL(8,2);

-- ⚠今入っている専有面積は、登記簿か壁芯か分からない(取り込みでお客様が書いた数字など)。
--   発注者の指示で**どちらの欄にも残さず、物件の備考へ移す**(値は消さず、備考の最後の行に足す)。
--   編集中の人の古い保存で備考を上書きしないよう version を上げる(更新日は変えない)。
UPDATE "properties"
   SET "note" = CASE
         WHEN "note" IS NULL OR btrim("note") = '' THEN line
         ELSE "note" || E'\n' || line
       END,
       "exclusive_area" = NULL,
       "version" = "version" + 1
  FROM (
    SELECT "id" AS pid,
           '専有面積（以前の記録・登記簿か壁芯か不明）: ' || trim_scale("exclusive_area")::text || '㎡' AS line
      FROM "properties"
     WHERE "exclusive_area" IS NOT NULL
  ) AS moved
 WHERE "properties"."id" = moved.pid;
