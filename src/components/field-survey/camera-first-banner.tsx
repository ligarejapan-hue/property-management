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
 *
 * 配置は呼び出し側の**画面上部中央スタック**が持つ(第1弾 A5)。以前ここに
 * あった absolute bottom-14 は、左下の現在地ボタンと同じ帯に覆いかぶさり、
 * 家を探すために現在地へ寄りたい瞬間にボタンを押せなくしていた。
 */

interface CameraFirstBannerProps {
  onCancel: () => void;
  /** 「撮り直す」=写真を捨てて**カメラを直接開く**(第2弾。従来はFAB押し直し)。 */
  onRetake?: () => void;
  /**
   * タップ待ちが写真を持っているか (発注者要望 2026-08-17「写真なしでピン」)。
   * false のときは「写真を撮りました」が嘘になるので、見出しと取消ボタンの
   * 言葉を切り替える (「撮り直す」も捨てる写真が無いのに嘘になる)。
   * 既定 true = 従来の撮影導線。
   */
  hasPhoto?: boolean;
}

export default function CameraFirstBanner({
  onCancel,
  onRetake,
  hasPhoto = true,
}: CameraFirstBannerProps) {
  return (
    <div
      role="status"
      data-testid="camera-first-banner"
      className="pointer-events-auto w-full rounded-md border border-indigo-300 bg-indigo-50 p-3 text-xs text-indigo-900 shadow dark:border-indigo-500/40 dark:bg-indigo-500/15 dark:text-indigo-200"
    >
      <p className="font-semibold">
        {hasPhoto ? "写真を撮りました" : "写真なしでピンを立てます"}
      </p>
      <p className="mt-1">
        地図で<b>家の上をタップ</b>してください。そこにピンを立てます。
      </p>
      <div className="mt-2 flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          data-testid="camera-first-cancel"
          className="rounded border border-indigo-300 bg-white px-3 py-1 text-[11px] text-indigo-900 hover:bg-indigo-100 dark:border-indigo-500/40 dark:bg-gray-900 dark:text-indigo-200 dark:hover:bg-gray-800"
        >
          やめる
        </button>
        {hasPhoto && onRetake && (
          <button
            type="button"
            onClick={onRetake}
            data-testid="camera-first-retake"
            className="rounded border border-indigo-600 bg-indigo-600 px-3 py-1 text-[11px] font-semibold text-white hover:bg-indigo-700 dark:border-indigo-500"
          >
            撮り直す(カメラを開く)
          </button>
        )}
      </div>
    </div>
  );
}
