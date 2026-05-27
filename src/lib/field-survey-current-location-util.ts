/**
 * 現地調査マップ Phase 1-F-3: 現在地表示 UI 用の純粋 helper。
 *
 * - 副作用なし (navigator.geolocation / fetch / localStorage / IndexedDB を呼ばない)
 * - lat/lng/accuracy を console / Error.message に流さない
 * - 表示用フォーマット (時刻 / 精度) と低精度判定のみを担う
 *
 * 低精度しきい値は FIELD_SURVEY_ACCURACY_WARN_M (= 100m) を再利用し、
 * TrackPoint 採用判定 / 警告ロジックとの一貫性を保つ。
 */

import { FIELD_SURVEY_ACCURACY_WARN_M } from "./field-survey-geolocation-util";

export const CURRENT_LOCATION_LOW_ACCURACY_THRESHOLD_M =
  FIELD_SURVEY_ACCURACY_WARN_M;

export function formatLocationTime(d: Date | null | undefined): string {
  if (!d || !(d instanceof Date) || Number.isNaN(d.getTime())) return "—";
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function formatAccuracyMeters(
  accuracy: number | null | undefined,
): string {
  if (
    accuracy === null ||
    accuracy === undefined ||
    !Number.isFinite(accuracy) ||
    accuracy < 0
  ) {
    return "—";
  }
  return `約${Math.round(accuracy)}m`;
}

export function isLowAccuracyForDisplay(
  accuracy: number | null | undefined,
  threshold: number = CURRENT_LOCATION_LOW_ACCURACY_THRESHOLD_M,
): boolean {
  if (accuracy === null || accuracy === undefined) return false;
  if (!Number.isFinite(accuracy)) return false;
  return accuracy > threshold;
}
