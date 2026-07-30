/**
 * 取込エラー行 CSV のダウンロード導線を出してよいかの判定（純関数）。
 *
 * この CSV は rawData を素で列展開するため**所有者の氏名・住所・電話が生で入る**。
 * route 側（`api/import/jobs/[jobId]/export-errors`）に権限ゲートがあるので、
 * 画面側の表示条件が一致していないと「押すたび 403 の JSON 画面に飛ぶリンク」を
 * 出し続けることになる。**route と同じ式をここ 1 箇所に置き、画面はこれを使う。**
 *
 * ⚠権限の「鮮度」も判定に含める。dashboard の layout は client navigation をまたいで
 * 保持されるため、provider が mount 時に 1 回取得しただけでは**別画面で権限を剥奪
 * された後の stale な granted 値**が残る。取得中・進入時の再取得が終わっていない間は
 * 「できない」に倒す（fail-safe＝緩めない側）。
 */

export interface PermissionLike {
  resource: string;
  action: string;
  granted: boolean;
}

export interface PermissionFreshness {
  /** provider が /api/me/permissions を取得中 */
  loading: boolean;
  /** ページ進入時の再取得がまだ完了していない（stale の可能性がある） */
  refreshPending: boolean;
}

export function canDownloadImportErrorCsv(
  permissions: readonly PermissionLike[] | null,
  freshness: PermissionFreshness,
): boolean {
  // 鮮度が確かでない間は出さない（stale な granted で一瞬でも押せる状態を作らない）。
  if (freshness.loading || freshness.refreshPending) return false;
  // null = 未取得 or 取得失敗 → 権限なし扱い（provider の規約と同じ fail-safe）。
  if (!permissions) return false;

  const has = (resource: string, action: string) =>
    permissions.some(
      (p) => p.resource === resource && p.action === action && p.granted,
    );

  return (
    has("import", "write") &&
    has("csv_export", "read") &&
    // 専用権限、または既に広い個人情報CSV権限（route 側と同じ OR 判定）
    (has("import_error_csv", "read") || has("csv_export_personal", "read"))
  );
}
