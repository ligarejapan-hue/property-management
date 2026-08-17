"use client";

/**
 * 「写真なしでピン」ボタン (発注者要望 2026-08-17)。
 *
 * 撮影 FAB (CameraFirstButton) の隣に置く副ボタン。押すと撮影と同じ
 * 「地図タップで位置決め」(awaiting-map-tap) に入るが、写真は持たない。
 * 現地で撮れない/撮る必要がない場面 (更地・遠目から見つけた候補など) でも
 * 物件化候補を立てられるようにする。
 *
 * - 見た目は撮影 FAB と同じ流儀 (アイコンのみの丸ボタン+aria-label/title)。
 *   主導線は撮影のままなので、こちらは控えめな白地にする。
 * - 表示可否の判定は親が撮影 FAB と同じ cameraFirstButtonState (純関数) を使う
 *   (出す場面・権限の条件が撮影と完全に同じため)。
 * - 権限なしの可視 note は撮影 FAB 側が出す (横並びで同文を2枚出さない)。
 * - 座標を扱わない。console / storage を使わない。
 */

import { MapPin } from "lucide-react";

interface PinWithoutPhotoButtonProps {
  disabled: boolean;
  /** field_survey:write 未付与が確定している (title で理由を示す)。 */
  permissionDenied: boolean;
  /** タップ待ち (awaiting-map-tap) を写真なしで開始する。 */
  onStart: () => void;
}

export default function PinWithoutPhotoButton({
  disabled,
  permissionDenied,
  onStart,
}: PinWithoutPhotoButtonProps) {
  return (
    <div className="pointer-events-none">
      <button
        type="button"
        onClick={onStart}
        disabled={disabled}
        data-testid="pin-without-photo-button"
        aria-label="写真なしでピンを登録"
        title={permissionDenied ? "ピン追加の権限がありません" : "写真なしでピン"}
        className="pointer-events-auto flex h-14 w-14 items-center justify-center rounded-full border border-indigo-700 bg-white text-indigo-700 shadow-lg hover:bg-indigo-50 disabled:cursor-not-allowed disabled:opacity-60 dark:border-indigo-500 dark:bg-gray-900 dark:text-indigo-300 dark:hover:bg-gray-800"
      >
        <MapPin className="h-7 w-7" aria-hidden="true" />
      </button>
    </div>
  );
}
