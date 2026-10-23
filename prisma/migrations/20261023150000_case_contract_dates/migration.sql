-- 案件ステータスが 契約予定/契約完了/決済完了 のときに入れる「契約予定日」「決済予定日」(2026-10-23 発注者指示)。
-- 列を足すだけ(既存の行は NULL=未定)。表は書き換えない・止まらない。
ALTER TABLE "properties"
  ADD COLUMN "contract_planned_on" DATE,
  ADD COLUMN "settlement_planned_on" DATE;
