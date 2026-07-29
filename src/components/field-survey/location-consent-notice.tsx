"use client";

/**
 * 位置記録の説明文 (単一の正本)。
 *
 * ⚠**表示する場所が2つある**ので、文言をここに集約する。
 *   1. 巡回開始の確認 modal — その端末で初めて巡回を始めるとき
 *   2. 位置記録の「再開」— 印の無い端末で巡回を復元したとき
 *      (機種変更 / 別ブラウザ / 履歴削除 / この反映より前に始まった巡回)
 *
 * 2 を落とすと「同意文を一度も見ていない端末で、押した瞬間に記録が始まる」
 * ことになる (@codex #333 P2)。片方だけ直して文言がずれるのを防ぐため、
 * 本文はこのファイルにしか書かない。
 *
 * lat / lng / 氏名 / session id は一切扱わない (表示専用)。
 */

/** 説明の本文。modal の中でも、開始確認の中でも同じものを出す。 */
export function LocationConsentNotice() {
  return (
    <ul className="ml-4 list-disc space-y-1 text-[11px] text-gray-700 dark:text-gray-200">
      <li>歩いた場所は、次にどのエリアを回るか決めるために使います。</li>
      <li>
        記録は巡回中だけです。止めたいときはパネルの「位置記録停止」で
        いつでも止められます。
      </li>
      <li>
        ブラウザを閉じたり画面を切り替えると、記録が止まることがあります。
      </li>
      <li>
        未送信の記録はブラウザを閉じると失われることがあります
        (端末側には保存しません)。
      </li>
    </ul>
  );
}

/**
 * 「再開」を押した端末に印が無いときだけ出す確認。
 * 同意されたら呼び出し側が印を残して記録を始める。
 */
export function LocationConsentModal({
  onCancel,
  onAgree,
}: {
  onCancel: () => void;
  onAgree: () => void;
}) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      data-testid="location-record-consent-modal"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
    >
      <div className="w-full max-w-md rounded-md bg-white p-4 text-sm shadow-lg dark:bg-gray-900">
        <h3 className="mb-2 text-base font-semibold text-gray-800 dark:text-gray-100">
          📍 位置記録について
        </h3>
        <div className="mb-3">
          <LocationConsentNotice />
        </div>
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded border border-gray-300 bg-white px-3 py-1 text-xs text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200 dark:hover:bg-gray-800"
          >
            キャンセル
          </button>
          <button
            type="button"
            onClick={onAgree}
            className="rounded border border-indigo-600 bg-indigo-600 px-3 py-1 text-xs font-semibold text-white hover:bg-indigo-700"
          >
            同意して記録開始
          </button>
        </div>
      </div>
    </div>
  );
}
