-- 問い合わせ者(反響の申込者の氏名)と除外申請(査定サイトへの課金除外の申し出)の欄(2026-10-24 従業員の指摘 第2弾・発注者承認)。
-- 列を足すだけ(既存の行は NULL=なし)。表は書き換えない。既存の行への値の入れ直しはしない(別途判断)。
ALTER TABLE "properties"
  ADD COLUMN "inquirer_name" TEXT,
  ADD COLUMN "lead_exclusion_status" TEXT,
  ADD COLUMN "lead_exclusion_requested_at" DATE,
  ADD COLUMN "lead_exclusion_decided_at" DATE;

-- 一覧の「除外申請」の絞り込み用。
CREATE INDEX "properties_lead_exclusion_status_idx" ON "properties"("lead_exclusion_status");
