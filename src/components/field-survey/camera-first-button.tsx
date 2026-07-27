"use client";

/**
 * カメラファースト撮影ボタン (巡回中に地図下部へ常設する FAB)。
 *
 * - タップで OS カメラを直接起動 (input accept="image/*" capture="environment")。
 *   撮影された file はそのまま親 (FieldSurveyMap) へ渡し、親が現在地取得→
 *   ピン作成 modal 起動を orchestrate する。ここでは位置情報を扱わない。
 * - 表示可否の判定は親が cameraFirstButtonState (純関数) で行う。
 *   本コンポーネントは押下可否 (disabled) と表示文言のみ担当。
 * - 座標 / File 内容を console に出さない。storage を使わない。
 */

import { useRef } from "react";

interface CameraFirstButtonProps {
  disabled: boolean;
  /** 現在地取得中 (撮影済み・位置解決待ち)。ラベルを進行表示に切替える。 */
  locating: boolean;
  /** field_survey:write 未付与が確定している (title で理由を示す)。 */
  permissionDenied: boolean;
  /**
   * 巡回外 (巡回なし撮影) で「巡回を開始」ボタンと横並びに置く場合 true。
   * 自前の absolute 配置をやめ、親の行レイアウトに従う (両方が
   * bottom-14 left-1/2 を占めて重なるのを防ぐ)。
   */
  inline?: boolean;
  /**
   * 撮影を始める瞬間 (カメラ起動の直前) に一度だけ呼ばれる。
   * 親はここで現在地の取得を先に走らせ、撮影と並行させる
   * (撮影後に取得を始めると、その分だけ保存画面が開くのを待たせる)。
   */
  onCaptureStart?: () => void;
  onPhotoCaptured: (file: File) => void;
}

export default function CameraFirstButton({
  disabled,
  locating,
  permissionDenied,
  inline = false,
  onCaptureStart,
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
      <button
        type="button"
        onClick={() => {
          // 現在地の取得を先に開始し、カメラ起動と並行させる。
          // 同じユーザー操作 (click) 内で呼ぶので、権限プロンプトが必要な
          // 初回でもジェスチャ由来として扱われる。
          onCaptureStart?.();
          inputRef.current?.click();
        }}
        disabled={disabled}
        data-testid="camera-first-button"
        aria-label="写真を撮ってピンを登録"
        title={permissionDenied ? "ピン追加の権限がありません" : undefined}
        className="pointer-events-auto flex items-center gap-2 rounded-full border border-indigo-700 bg-indigo-600 px-5 py-3 text-sm font-semibold text-white shadow-lg hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-60 dark:border-indigo-500"
      >
        <span aria-hidden="true">📷</span>
        {locating ? "現在地を取得中…" : "撮って登録"}
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
