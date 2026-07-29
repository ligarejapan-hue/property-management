"use client";

/**
 * 撮影後の「地図タップで位置指定待ち」banner。
 *
 * ⚠**これは失敗時の代替手段ではなく、通常の手順**になった (2026-07-29)。
 * 以前は現在地が取れなかった時だけ出る案内で、文面も「取得できませんでした」
 * という失敗理由だった。いまは位置を必ずタップで決めるので、
 * **失敗理由ではなく次にやることだけ**を書く。
 *
 * ⚠「家の上」と書くのは業務上の意味がある。端末が返す現在地は道路（立って
 * いる場所）を指すため、そのままでは対象の家が分からなくなる。現地で家の前に
 * 立っているうちに家の上を指してもらう。
 *
 * 座標・技術用語は文言に含めない。
 */

interface CameraFirstBannerProps {
  onCancel: () => void;
}

export default function CameraFirstBanner({
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
        地図で<b>家の上をタップ</b>してください。そこにピンを立てます。
      </p>
      <div className="mt-2 flex justify-end">
        <button
          type="button"
          onClick={onCancel}
          data-testid="camera-first-cancel"
          className="rounded border border-indigo-300 bg-white px-3 py-1 text-[11px] text-indigo-900 hover:bg-indigo-100 dark:border-indigo-500/40 dark:bg-gray-900 dark:text-indigo-200 dark:hover:bg-gray-800"
        >
          撮り直す
        </button>
      </div>
    </div>
  );
}
