-- 案件ステータスに「除外申請中」「除外」を足す(2026-10-25 発注者決定)。除外申請の欄と連動する。
-- 見送り・終了(closed)のすぐ後ろに「除外申請中」→「除外」の順で置く=一覧の「案件ステータス順」もこの順になる。
-- ⚠2つとも AFTER 'closed' にする(同じトランザクションで足したばかりの値を AFTER に使わない)。後に足した方が closed の直後に来る。
-- ADD VALUE は表を書き換えない(既存の物件の値は変わらない・止まらない)。
ALTER TYPE "CaseStatus" ADD VALUE IF NOT EXISTS 'lead_excluded' AFTER 'closed';
ALTER TYPE "CaseStatus" ADD VALUE IF NOT EXISTS 'lead_exclusion_requested' AFTER 'closed';
