"use client";

/**
 * カメラファーストの「地図タップで位置指定待ち」banner。
 *
 * 撮影済みだが現在地が取れなかった (http 環境 / 権限拒否 / タイムアウト) 場合に
 * 地図下部へ表示し、地図タップでの位置指定へ誘導する。「やり直す」で撮影ごと破棄。
 * 座標・技術用語は文言に含めない。
 */

interface CameraFirstBannerProps {
  /** 現在地が取れなかった理由の案内文 (cameraFirstFallbackMessage)。null は既定文。 */
  notice: string | null;
  onCancel: () => void;
}

export default function CameraFirstBanner({
  notice,
  onCancel,
}: CameraFirstBannerProps) {
  return (
    <div
      role="status"
      data-testid="camera-first-banner"
      className="pointer-events-auto absolute bottom-14 left-1/2 z-10 w-[calc(100%-1.5rem)] max-w-sm -translate-x-1/2 rounded-md border border-indigo-300 bg-indigo-50 p-3 text-xs text-indigo-900 shadow dark:border-indigo-500/40 dark:bg-indigo-500/15 dark:text-indigo-200"
    >
      <p className="font-semibold">写真を撮りました</p>
      <p className="mt-1">
        {notice ?? "地図をタップして、撮った場所を指定してください。"}
      </p>
      <div className="mt-2 flex justify-end">
        <button
          type="button"
          onClick={onCancel}
          data-testid="camera-first-cancel"
          className="rounded border border-indigo-300 bg-white px-3 py-1 text-[11px] text-indigo-900 hover:bg-indigo-100 dark:border-indigo-500/40 dark:bg-gray-900 dark:text-indigo-200 dark:hover:bg-gray-800"
        >
          やり直す
        </button>
      </div>
    </div>
  );
}
