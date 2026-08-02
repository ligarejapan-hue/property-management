/**
 * 取込ジョブの閲覧・操作スコープ（担当分だけ / 全員分）。
 *
 * 背景（2026-08-02 監査）: 取込ジョブの一覧・詳細・行データ・エラーCSV・ロールバックは
 * すべて `import:write` だけで通っており、**他人が実行した取込の生データ**
 * （ImportJobRow.rawData = 所有者の氏名・住所・電話がそのまま入る）を誰でも
 * 横断閲覧できた。物件側で先に導入した「担当分だけ」の考え方（担当者スコープ統一）を
 * 取込側にも揃える。
 *
 * ルール:
 *   - `import:read_all` を持つ（既定は管理者テンプレのみ）→ 全員分を見られる
 *   - 持たない（事務担当など）→ **自分が実行した取込だけ**
 *
 * ⚠fail-closed: 権限が読めない・executedBy が取れない場合は「見えない」側に倒す。
 */
import { ApiError } from "@/lib/api-helpers";
import { hasPermission } from "@/lib/permissions";

type PermissionEntry = Parameters<typeof hasPermission>[0][number];

/** 全員分の取込ジョブを見られるか（既定は管理者のみ）。 */
export function canSeeAllImportJobs(permissions: PermissionEntry[]): boolean {
  return hasPermission(permissions, "import", "read_all");
}

/**
 * 一覧クエリに足す where 断片。全員分を見られないなら自分の実行分に限定する。
 * 呼び出し側の任意フィルタ（executedBy クエリ）より**後に**マージして上書きすること。
 */
export function importJobScopeWhere(
  sessionUserId: string,
  permissions: PermissionEntry[],
): { executedBy?: string } {
  return canSeeAllImportJobs(permissions) ? {} : { executedBy: sessionUserId };
}

/**
 * 単一ジョブへのアクセス可否。可視でなければ 403 を投げる。
 * ⚠呼び出し側は job の select に `executedBy` を含めること。
 *
 * 「存在するが他人のもの」を 404 ではなく 403 にするのは、取込ジョブ ID は
 * 画面内でしか露出せず、存在の有無自体が秘匿対象ではないため（物件側と同じ姿勢）。
 */
export function assertImportJobVisible(
  job: { executedBy: string | null },
  sessionUserId: string,
  permissions: PermissionEntry[],
): void {
  if (canSeeAllImportJobs(permissions)) return;
  if (job.executedBy && job.executedBy === sessionUserId) return;
  throw new ApiError(
    403,
    "他の担当者が実行した取込にはアクセスできません",
    "FORBIDDEN",
  );
}
