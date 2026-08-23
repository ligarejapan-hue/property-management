"use client";

/**
 * カメラファースト撮影ボタン (巡回中に地図下部へ常設する FAB)。
 *
 * - 見た目は**カメラマークだけの丸ボタン** (2026-08-03 発注者指示)。文字を持たない
 *   ぶん、用途は aria-label / title で必ず伝える。
 * - タップで OS カメラを直接起動 (input accept="image/*" capture="environment")。
 *   撮影された file はそのまま親 (FieldSurveyMap) へ渡し、親が現在地取得→
 *   ピン作成 modal 起動を orchestrate する。ここでは位置情報を扱わない。
 * - 表示可否の判定は親が cameraFirstButtonState (純関数) で行う。
 *   本コンポーネントは押下可否 (disabled) と表示文言のみ担当。
 * - 座標 / File 内容を console に出さない。storage を使わない。
 */

import { useEffect, useRef } from "react";
import { Camera } from "lucide-react";

interface CameraFirstButtonProps {
  disabled: boolean;
  /** field_survey:write 未付与が確定している (title で理由を示す)。 */
  permissionDenied: boolean;
  /**
   * 巡回外 (巡回なし撮影) で「巡回を開始」ボタンと横並びに置く場合 true。
   * 自前の absolute 配置をやめ、親の行レイアウトに従う (両方が
   * bottom-14 left-1/2 を占めて重なるのを防ぐ)。
   */
  inline?: boolean;
  onPhotoCaptured: (file: File) => void;
}

export default function CameraFirstButton({
  disabled,
  permissionDenied,
  inline = false,
  onPhotoCaptured,
}: CameraFirstButtonProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0] ?? null;
    // 同じ写真を続けて撮り直しても change が発火するよう毎回リセットする。
    e.target.value = "";
    if (file) onPhotoCaptured(file);
  };

  return (
    <div
      className={
        inline
          ? "pointer-events-none"
          : "pointer-events-none absolute bottom-14 left-1/2 z-10 -translate-x-1/2"
      }
    >
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="hidden"
        data-testid="camera-first-input"
        onChange={handleChange}
      />
      {/* ⚠**カメラマークだけの丸ボタン**にする (2026-08-03 発注者指示)。
          文字を消すぶん「何のボタンか」を伝える手段は必ず残す:
          aria-label (読み上げ) と title (PC のツールチップ)。 */}
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        disabled={disabled}
        data-testid="camera-first-button"
        aria-label="写真を撮ってピンを登録"
        title={permissionDenied ? "ピン追加の権限がありません" : "撮って登録"}
        className="pointer-events-auto flex h-14 w-14 items-center justify-center rounded-full border border-indigo-700 bg-indigo-600 text-white shadow-lg hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-60 dark:border-indigo-500"
      >
        <Camera className="h-7 w-7" aria-hidden="true" />
      </button>
      {/* title のツールチップはタッチ端末で出ないため、権限なしの理由は
          可視テキストでも示す (PinAddModeToggle と同文言)。 */}
      {permissionDenied && (
        <p
          role="status"
          data-testid="camera-first-permission-note"
          className="pointer-events-auto mt-1 rounded bg-white/90 px-2 py-0.5 text-center text-[10px] text-amber-700 shadow dark:bg-gray-900/90 dark:text-amber-300"
        >
          ピン追加の権限がありません。
        </p>
      )}
    </div>
  );
}
