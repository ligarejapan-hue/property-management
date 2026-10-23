-- 書類の自動整理(2026-10-23 発注者要望): 添付に「段階」「種類」「そろえた名前」「確からしさ」を足す。
-- 列を足すだけ(既存の行は NULL=その他・元の名前のまま)。表は書き換えない・止まらない。
ALTER TABLE "attachments"
  ADD COLUMN "doc_stage" TEXT,
  ADD COLUMN "doc_kind" TEXT,
  ADD COLUMN "doc_title" TEXT,
  ADD COLUMN "doc_confidence" TEXT;
