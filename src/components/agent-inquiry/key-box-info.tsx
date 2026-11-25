/**
 * キーボックスの設置場所・解除番号(2026-11-26 発注者)。内見の電話で業者さんへそのまま伝えられるように、
 * 受付の窓(登録フォーム・反響の詳細・今日明日の内見)と物件の反響タブに出す。
 * ⚠全員に見せる値(発注者決定)。どちらも未入力なら何も出さない。
 */
export function KeyBoxInfo({
  location,
  code,
  className = "",
}: {
  location?: string | null;
  code?: string | null;
  className?: string;
}) {
  const loc = location?.trim() || null;
  const num = code?.trim() || null;
  if (!loc && !num) return null;
  return (
    <p
      data-testid="key-box-info"
      aria-label="キーボックス"
      className={`text-xs text-gray-700 dark:text-gray-300 ${className}`}
    >
      <span className="font-medium">キーボックス</span>
      {loc && <span className="ml-1">{loc}</span>}
      {num && (
        <span className="ml-2">
          解除番号 <b className="font-mono tabular-nums">{num}</b>
        </span>
      )}
    </p>
  );
}
