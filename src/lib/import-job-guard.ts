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

/**
 * 全員分の取込ジョブを**見られる**か（既定は管理者のみ）。
 * `import:manage`（他人の分も操作できる）は上位互換なので閲覧も当然できる。
 */
export function canSeeAllImportJobs(permissions: PermissionEntry[]): boolean {
  return (
    hasPermission(permissions, "import", "read_all") ||
    canManageOthersImportJobs(permissions)
  );
}

/**
 * 他人の取込ジョブを**操作**（ロールバック・行の再実行/解決・失敗マーク等）できるか。
 *
 * ⚠read_all と分ける理由（Codex #349 R8 P1）: 画面上「全員分の閲覧」と表示される
 * 権限が、実際にはロールバック等の破壊的操作まで許してしまうと、権限名と実際の力が
 * 食い違う。現地調査の read_all（見るだけ）/ manage（他の人の分も編集）と同じ分け方に揃える。
 */
export function canManageOthersImportJobs(
  permissions: PermissionEntry[],
): boolean {
  return hasPermission(permissions, "import", "manage");
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

/**
 * 単一ジョブへの**変更**（ロールバック・行の再実行/解決・失敗マーク・手動紐づけ等）の可否。
 * 自分の実行分は常に可。他人の分は `import:manage` が必要（read_all では不可）。
 * ⚠呼び出し側は job の select に `executedBy` を含めること。
 */
export function assertImportJobMutable(
  job: { executedBy: string | null },
  sessionUserId: string,
  permissions: PermissionEntry[],
): void {
  if (canManageOthersImportJobs(permissions)) return;
  if (job.executedBy && job.executedBy === sessionUserId) return;
  throw new ApiError(
    403,
    "他の担当者が実行した取込は変更できません",
    "FORBIDDEN",
  );
}
