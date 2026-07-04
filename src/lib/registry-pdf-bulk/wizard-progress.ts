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

// サーバ(registry-pdf-bulk/route.ts)と同じ上限。クライアント側で事前に弾くことで、
// 明らかに超過している選択をサーバへ送らずに済む(体感速度・無駄な通信の削減)。
// サーバ側の上限は正本のまま(このチェックはUX向上のためのみで、認可/検証を代替しない)。
const MAX_BULK_FILES = 100;
const MAX_BULK_TOTAL_BYTES = 100 * 1024 * 1024;

/**
 * PDF一括アップロードのクライアント側事前チェック。
 * 件数(100件)または合計サイズ(100MB)の上限を超える場合、表示用エラー文言を返す。
 * 問題なければ null。
 */
export function validateBulkSelection(
  files: Array<{ size: number }>,
): string | null {
  if (files.length > MAX_BULK_FILES) {
    return `一度に選択できるのは${MAX_BULK_FILES}件までです(現在${files.length}件)。分割して投入してください`;
  }
  const totalBytes = files.reduce((sum, f) => sum + f.size, 0);
  if (totalBytes > MAX_BULK_TOTAL_BYTES) {
    const totalMb = (totalBytes / 1024 / 1024).toFixed(1);
    return `合計サイズが上限(100MB)を超えています(現在${totalMb}MB)。分割して投入してください`;
  }
  return null;
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
