-- 通知 段階4b: 謄本の一括取得の完了を定期実行が (completed_at, id) の順に読む(カーソルより後・5分の読み直し)。
-- その範囲の読み取りと並び替えを索引で済ませる(完了ジョブが溜まっても時間切れにならない・@codex #472 P2)。
--
-- 書き込み中の表なので、索引を作る間に書き込みを止めないよう CONCURRENTLY で作る。
--   - CONCURRENTLY は BEGIN/COMMIT の中では流せないので、このファイルには置かない
--     (20260527000000_add_property_gps_bbox_index と同じ作り)。
--   - 失敗して INVALID の索引が残ったときは
--     `DROP INDEX CONCURRENTLY "registry_fetch_jobs_status_completed_at_id_idx";` → 
--     `npx prisma migrate resolve --rolled-back 20261004100500_add_registry_job_completed_index` → deploy でやり直す。

CREATE INDEX CONCURRENTLY "registry_fetch_jobs_status_completed_at_id_idx"
  ON "registry_fetch_jobs"("status", "completed_at", "id");
