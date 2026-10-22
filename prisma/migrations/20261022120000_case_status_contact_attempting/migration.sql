-- 案件ステータスに「コンタクト中」を足す(2026-10-22 発注者決定)。
-- 未着手(new_case)と所有者とやりとり中(contacting_owner)の間に置く=一覧の「案件ステータス順」もこの順になる。
-- ADD VALUE は表を書き換えない(既存の物件の値は変わらない・止まらない)。
ALTER TYPE "CaseStatus" ADD VALUE IF NOT EXISTS 'contact_attempting' BEFORE 'contacting_owner';
