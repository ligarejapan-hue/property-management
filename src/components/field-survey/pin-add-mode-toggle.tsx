"use client";

/**
 * Phase 1-G: 「ピン追加」モード toggle。
 *
 * - active session が無い間は呼び出し側 (FieldSurveyMap) が render しない。
 * - field_survey:write 不所持時は API 側で 403 になる。UI 側でも write 不所持と
 *   既知の場合は disable 表示する (canWrite=false)。判定不能 (`canWrite=null`)
 *   なら押下可能とし、API 403 を `pinApiErrorMessage` で汎用化する。
 * - 座標 / メモ / API キーを console に出さない (本コンポーネントは直接扱わない)。
 */

interface PinAddModeToggleProps {
  active: boolean;
  onToggle: () => void;
  /**
   * null = 判定不能 (UI では押下を許可し API 側で 403 確認)。
   * true / false = 既知の権限。false なら disable。
   */
  canWrite: boolean | null;
}

export default function PinAddModeToggle({
  active,
  onToggle,
  canWrite,
}: PinAddModeToggleProps) {
  const disabled = canWrite === false;
  return (
    <div className="mt-2 border-t border-gray-200 pt-2">
      <div className="mb-1 text-xs font-semibold text-gray-600">調査ピン</div>
      <button
        type="button"
        onClick={onToggle}
        disabled={disabled}
        aria-pressed={active}
        data-testid="pin-add-mode-toggle"
        className={
          "w-full rounded border px-2 py-1 text-xs font-semibold " +
          (active
            ? "border-indigo-600 bg-indigo-600 text-white hover:bg-indigo-700"
            : "border-blue-300 bg-blue-50 text-blue-700 hover:bg-blue-100") +
          " disabled:cursor-not-allowed disabled:opacity-60"
        }
      >
        {active ? "ピン追加モード: ON" : "ピン追加モード"}
      </button>
      <p className="mt-1 text-[10px] leading-tight text-gray-500">
        {active
          ? "地図をタップした位置にピンを追加します。"
          : "巡回中の地点に調査ピンを残せます。"}
      </p>
      {disabled && (
        <p className="mt-1 text-[10px] text-amber-700">
          ピン追加の権限がありません。
        </p>
      )}
    </div>
  );
}
