"use client";

/**
 * 現地調査マップ Phase 1-F-3: 現在地ステータス UI (pure component)。
 *
 * - useFieldSurveyLocationRecorder の latestPositionForDisplay /
 *   isWaitingForFirstLocation / lastLocationErrorForDisplay を受け取って
 *   描画するだけ。navigator.geolocation は触らない。
 * - lat / lng / raw position / API key を UI / console に出さない。
 *   表示するのは「最終取得時刻 (HH:MM:SS)」と「精度 (約Nm)」のみ。
 * - 「現在地へ移動」ボタンはクリック時のみ panTo を呼ぶ (自動 pan しない)。
 *   latestPositionForDisplay が無い時は disabled。
 */

import {
  formatAccuracyMeters,
  formatLocationTime,
  isLowAccuracyForDisplay,
} from "@/lib/field-survey-current-location-util";

export interface CurrentLocationLatest {
  lat: number;
  lng: number;
  accuracy: number | null;
  capturedAt: Date;
}

export interface CurrentLocationStatusProps {
  latestPositionForDisplay: CurrentLocationLatest | null;
  isWaitingForFirstLocation: boolean;
  lastLocationErrorForDisplay: string | null;
  recording: boolean;
  onPanToCurrent: () => void;
}

export default function CurrentLocationStatus({
  latestPositionForDisplay,
  isWaitingForFirstLocation,
  lastLocationErrorForDisplay,
  recording,
  onPanToCurrent,
}: CurrentLocationStatusProps) {
  const hasPosition = latestPositionForDisplay !== null;
  const accuracy = latestPositionForDisplay?.accuracy ?? null;
  const lowAccuracy = isLowAccuracyForDisplay(accuracy);
  // Codex P2 (Phase 1-F-3 follow-up): hook 側で error / stop 時に
  // latestPositionForDisplay を null にクリアするが、recording 中以外は
  // pan ボタンを構造的にも有効にしない (古い座標への panTo を防ぐ二重ガード)。
  const canPanToCurrent = recording && hasPosition;

  // Codex P2 (Phase 1-F-3): hook 側 stop / stopBeforeSessionEnd で
  // latestPositionForDisplay を null に倒すため、停止中は常に「停止中」のみ表示し、
  // 「最後の取得値」を流用しない。pan ボタンも hasPosition が false で disabled。
  const statusText = (() => {
    if (recording && !hasPosition) return "取得待ち…";
    if (recording && hasPosition) return "取得済";
    return "停止中";
  })();

  return (
    <div
      className="mt-2 border-t border-gray-200 dark:border-gray-800 pt-2"
      data-testid="current-location-section"
    >
      <div className="mb-1 text-xs font-semibold text-gray-600 dark:text-gray-300">現在地</div>
      <dl className="grid grid-cols-[max-content_1fr] gap-x-2 gap-y-0.5 text-[11px] text-gray-700 dark:text-gray-200">
        <dt>状態</dt>
        <dd data-testid="current-location-state">{statusText}</dd>
        <dt>最終取得</dt>
        <dd data-testid="current-location-captured-at">
          {hasPosition
            ? formatLocationTime(latestPositionForDisplay!.capturedAt)
            : "—"}
        </dd>
        <dt>精度</dt>
        <dd data-testid="current-location-accuracy">
          {formatAccuracyMeters(accuracy)}
        </dd>
      </dl>

      {lowAccuracy && (
        <p
          className="mt-1 rounded border border-amber-300 bg-amber-50 px-2 py-1 text-[10px] text-amber-800 dark:border-amber-500/40 dark:bg-amber-500/15 dark:text-amber-300"
          data-testid="current-location-low-accuracy-warning"
        >
          低精度です。屋外や窓際で再度お試しください。
        </p>
      )}

      {isWaitingForFirstLocation && !lowAccuracy && (
        <p
          className="mt-1 rounded border border-gray-200 bg-gray-50 px-2 py-1 text-[10px] text-gray-700 dark:border-gray-800 dark:bg-gray-800/50 dark:text-gray-200"
          data-testid="current-location-waiting"
        >
          現在地を取得中です。屋外や窓際で数十秒お待ちください。
        </p>
      )}

      {lastLocationErrorForDisplay && (
        <p
          role="status"
          className="mt-1 rounded border border-amber-300 bg-amber-50 px-2 py-1 text-[11px] text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/15 dark:text-amber-300"
          data-testid="current-location-error"
        >
          {lastLocationErrorForDisplay}
        </p>
      )}

      <button
        type="button"
        onClick={() => onPanToCurrent()}
        disabled={!canPanToCurrent}
        className="mt-2 w-full rounded border border-blue-300 bg-blue-50 px-2 py-1 text-xs font-semibold text-blue-700 hover:bg-blue-100 disabled:cursor-not-allowed disabled:opacity-60 dark:border-blue-500/40 dark:bg-blue-500/20 dark:text-blue-300 dark:hover:bg-blue-500/30"
        data-testid="current-location-pan-button"
      >
        現在地へ移動
      </button>
    </div>
  );
}
