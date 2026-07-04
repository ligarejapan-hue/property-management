/**
 * 所有者事項PDF一括ジョブの進捗表示用の純関数。
 * ウィザード(ポーリング)とジョブ詳細の両方から使う。
 */

export interface BulkJobProgress {
  total: number;
  done: number;
  finished: boolean;
  label: string;
}

export function summarizeBulkJobProgress(job: {
  totalRows: number | null;
  pendingCount?: number;
  successCount: number | null;
  errorCount: number | null;
  status: string;
}): BulkJobProgress {
  const total = job.totalRows ?? 0;
  const pending = job.pendingCount ?? 0;
  const done = Math.max(0, total - pending);
  const finished = job.status === "completed" || job.status === "failed";
  const label = finished
    ? `${job.status === "failed" ? "完了(一部失敗)" : "完了"} ${done}/${total}件`
    : `処理中 ${done}/${total}件`;
  return { total, done, finished, label };
}
