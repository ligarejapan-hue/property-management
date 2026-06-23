import { getApiSession, getUserPermissions } from "@/lib/api-helpers";
import { hasPermission } from "@/lib/permissions";
import SessionHistoryClient from "@/components/field-survey/session-history-client";

// Phase 1-J: 巡回セッション一覧 (過去ルート閲覧の入口)。
// - server 側で field_survey:read を gate する。
// - read_all / manage を持つ場合のみ「全員」スコープ切替を client に許可する。
// - 一覧は座標 / memo / 写真情報 / PII を出さない (API も返さない)。

export default async function FieldSurveySessionsPage() {
  let canRead = false;
  let canSeeAll = false;
  try {
    const session = await getApiSession();
    const permissions = await getUserPermissions(session.id);
    canRead = hasPermission(permissions, "field_survey", "read");
    canSeeAll =
      hasPermission(permissions, "field_survey", "read_all") ||
      hasPermission(permissions, "field_survey", "manage");
  } catch {
    canRead = false;
  }

  if (!canRead) {
    return (
      <div className="p-6">
        <div className="rounded-md border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/15 dark:text-amber-300">
          巡回履歴を閲覧する権限がありません。
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col">
      <header className="border-b border-gray-200 bg-white px-4 py-3 dark:border-gray-800 dark:bg-gray-900">
        <h1 className="text-lg font-semibold text-gray-800 dark:text-gray-100">巡回履歴</h1>
        <p className="text-xs text-gray-500 dark:text-gray-400">
          過去の巡回セッションを一覧で確認し、地図で過去ルートを閲覧します。
        </p>
      </header>
      <SessionHistoryClient canSeeAll={canSeeAll} />
    </div>
  );
}
