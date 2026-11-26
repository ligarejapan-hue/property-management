-- 物件の契約日・決済予定日を、連動する取引の契約日時・決済日時にそろえる(一度だけ・2026-11-26 発注者「入れるのは取引からのみ」)。
-- 以後は取引の保存のたびにアプリがそろえる(src/lib/deals/case-dates-sync.ts)。
--  - 連動する取引 = 新しい順(created_at desc, id desc)で中止でない最初の取引、全部中止なら一番新しい取引(src/lib/deals/linked-deal.ts と同じ)。
--  - 取引の日時は UTC で保存(timestamp without time zone)=日本の日付は +9 時間して日付にする。
--  - 取引の日付が空なら物件の日付も空にする(取引の日付で上書き・発注者決定)。取引の無い物件は触らない。
--  - 列・表は変えない(値の書き換えだけ)。物件の版(version)は上げない(案件ステータスの連動と同じ)。
UPDATE "properties" AS p
SET "contract_planned_on" = (d."contract_at" + interval '9 hours')::date,
    "settlement_planned_on" = (d."settlement_at" + interval '9 hours')::date
FROM (
  SELECT DISTINCT ON ("property_id") "property_id", "contract_at", "settlement_at"
  FROM "deals"
  WHERE "property_id" IS NOT NULL
  ORDER BY "property_id", ("status" = 'cancelled'), "created_at" DESC, "id" DESC
) AS d
WHERE p."id" = d."property_id"
  AND (
    p."contract_planned_on" IS DISTINCT FROM (d."contract_at" + interval '9 hours')::date
    OR p."settlement_planned_on" IS DISTINCT FROM (d."settlement_at" + interval '9 hours')::date
  );
