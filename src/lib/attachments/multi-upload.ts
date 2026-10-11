/**
 * 添付タブで複数ファイルをまとめて送るときの表示(純関数)。
 * 2026-10-12 ご指摘「複数ファイルをドロップしても1つしか入らない」への対応。
 */

export interface UploadProgress {
  current: number;
  total: number;
}

export interface UploadFailure {
  /** 何件目か(1 から)。 */
  index: number;
  fileName: string;
  reason: string;
}

/** 送っている間の「3件中2件目 」(1件だけのときは空)。 */
export function uploadProgressLabel(progress: UploadProgress | null): string {
  if (progress === null || progress.total <= 1) return "";
  return `${progress.total}件中${progress.current}件目 `;
}

/**
 * 失敗した分だけをまとめた文言。失敗が無ければ null。
 * ⚠謄本はファイル名に所有者名が入り得るので、showFileNames=false では何件目かだけを出す。
 */
export function uploadFailureMessage(
  failures: readonly UploadFailure[],
  total: number,
  opts: { showFileNames: boolean },
): string | null {
  if (failures.length === 0) return null;
  if (total <= 1) return failures[0].reason;
  const lines = failures.map(
    (f) => `${opts.showFileNames ? f.fileName : `${f.index}件目`}: ${f.reason}`,
  );
  return `${total}件中${failures.length}件を保存できませんでした（${lines.join(" / ")}）`;
}
