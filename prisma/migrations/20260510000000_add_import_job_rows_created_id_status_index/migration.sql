-- 物件一覧の管理ID逆引きクエリ（createdId IN (...) AND status = 'success'）を
-- 高速化するための複合インデックス。createdAt を含めることで ORDER BY createdAt
-- の sort も index-only で処理できる。
CREATE INDEX "import_job_rows_created_id_status_created_at_idx"
  ON "import_job_rows"("created_id", "status", "created_at");
