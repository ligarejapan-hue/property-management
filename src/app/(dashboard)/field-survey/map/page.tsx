import FieldSurveyMapClient from "@/components/field-survey/field-survey-map-client";
import { getApiSession, getUserPermissions } from "@/lib/api-helpers";
import { hasPermission } from "@/lib/permissions";

// Phase 1-E: 現地調査マップの server-side 入口。
// - field_survey:read 権限を server component で gate する (Codex Phase 1-E)。
//   未許可なら FieldSurveyMapClient (= Maps JS API loader を含む client tree)
//   を一切 render しない → Google Maps JavaScript API の課金パスに乗らない。
// - 権限 OK の場合のみ client component に降りて、env (APIキー / billing /
//   MAP_ID) ベースの追加 gating を経由してから FieldSurveyMap を mount する。
// - 巡回開始/終了, navigator.geolocation, TrackPoint 送信, Pin 作成・編集は
//   別 PR で実装する。

export default async function FieldSurveyMapPage() {
  // 401 / 想定外の失敗はすべて「閲覧不可」扱いに倒し、Maps loader を起動しない。
  // env 値・APIキー・session 詳細は出力しない。
  let canRead = false;
  try {
    const session = await getApiSession();
    const permissions = await getUserPermissions(session.id);
    canRead = hasPermission(permissions, "field_survey", "read");
  } catch {
    canRead = false;
  }

  return (
    <div className="flex h-[calc(100vh-3.5rem)] flex-col">
      <header className="flex items-center justify-between border-b border-gray-200 bg-white px-4 py-3">
        <div>
          <h1 className="text-lg font-semibold text-gray-800">
            現地調査マップ
          </h1>
          <p className="text-xs text-gray-500">
            既存物件と調査ピンを地図上で確認します。
            巡回開始 / 終了は次フェーズで実装予定。
          </p>
        </div>
      </header>

      <div className="flex-1 overflow-hidden">
        {canRead ? <FieldSurveyMapClient /> : <PermissionDeniedNotice />}
      </div>
    </div>
  );
}

function PermissionDeniedNotice() {
  // field_survey:read 不足。Maps loader を持つ client tree を mount しないため、
  // Google Maps JavaScript API の課金パスに乗らないことを構造的に保証する。
  // APIキー / Map ID / billing 設定値はこの fallback に出さない (UI レベルの分離)。
  return (
    <div
      role="alert"
      data-testid="field-survey-permission-denied"
      className="flex h-full items-center justify-center bg-gray-50 p-6"
    >
      <div className="max-w-xl rounded-md border border-amber-300 bg-amber-50 p-6 text-sm text-amber-900">
        <h2 className="mb-2 text-base font-semibold">
          現地調査マップの閲覧権限がありません
        </h2>
        <p className="text-xs text-amber-800">
          管理者に field_survey:read 権限を確認してください。
        </p>
      </div>
    </div>
  );
}
