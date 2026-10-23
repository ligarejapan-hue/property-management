-- 書類の受け取り箱(2026-10-24): 査定報告書だけだった受け取り箱を全書類へ広げる。
-- 列を足すだけ(既存の行は PDF)。表は書き換えない・止まらない。
ALTER TABLE "report_inbox_items"
  ADD COLUMN "mime_type" TEXT NOT NULL DEFAULT 'application/pdf',
  ADD COLUMN "doc_kind" TEXT,
  ADD COLUMN "doc_stage" TEXT,
  ADD COLUMN "doc_confidence" TEXT,
  ADD COLUMN "doc_date" TEXT;

-- これまで受け取り箱に入っていたものはすべて査定報告書(それしか受けなかった)。
-- 反映前から残っている未処理の行は、書式が読めなかったもの(source=unknown)も含めて「査定書・査定報告書」として
-- 扱い、今までどおり report で添付できるようにする(新しく足した列にだけ値を入れる。ほかの列は触らない)。
UPDATE "report_inbox_items"
   SET "doc_kind" = 'appraisal_report', "doc_stage" = 'pre_contract', "doc_confidence" = 'high'
 WHERE "status" = 'pending' AND "doc_kind" IS NULL;
