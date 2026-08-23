"use client";

/**
 * 絞り込み枠 (UI一貫性 第2弾 ⑦・発注者承認 2026-08-23)。
 *
 * 背景: 監査ログ・添付検索・孤児DM記録・取込履歴などが5〜9個の操作を
 * 各自バラバラに常時展開で実装していた(実測)。物件一覧(第1弾)と同じ
 * 「よく使う条件は常時+残りは『詳細条件 ▾』」の形を部品化する。規約:
 *   - primary(常時行)の**左端・最初は検索窓**(SearchField)に置く
 *   - 詳細条件が適用中は「（N件適用中）」を出し、**最初から開く**
 *     (畳んだまま適用されていると「なぜ絞れているのか」が分からない)
 *   - 枠の見た目は物件一覧と同一(rounded-lg border 白/dark)
 */
import { useState, type ReactNode } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";

export interface FilterPanelProps {
  /** 常時表示の行(検索窓・よく使う選択・リセット等)。 */
  primary: ReactNode;
  /** 「詳細条件 ▾」で畳む部分。省略時はトグル自体を出さない。 */
  advanced?: ReactNode;
  /** 詳細条件のうち適用中の数。>0 なら「（N件適用中）」+初期展開。 */
  advancedCount?: number;
  /** 初期展開の明示指定(URL復元等)。省略時は advancedCount>0 で開く。 */
  initialOpen?: boolean;
  className?: string;
}

export function FilterPanel({
  primary,
  advanced,
  advancedCount = 0,
  initialOpen,
  className,
}: FilterPanelProps) {
  const [open, setOpen] = useState(initialOpen ?? advancedCount > 0);
  const hasAdvanced = advanced !== undefined;
  return (
    <div
      className={`mb-6 rounded-lg border border-gray-200 bg-white p-4 shadow-sm dark:border-gray-800 dark:bg-gray-900${className ? ` ${className}` : ""}`}
    >
      <div className="flex flex-wrap items-center gap-3">
        {primary}
        {hasAdvanced && (
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            className="inline-flex items-center gap-1 rounded-md px-2 py-1.5 text-sm text-gray-600 hover:bg-gray-50 hover:text-gray-800 dark:text-gray-300 dark:hover:bg-gray-800 dark:hover:text-gray-100"
          >
            詳細条件
            {advancedCount > 0 ? `（${advancedCount}件適用中）` : ""}
            {open ? (
              <ChevronUp className="h-4 w-4" />
            ) : (
              <ChevronDown className="h-4 w-4" />
            )}
          </button>
        )}
      </div>
      {hasAdvanced && open && (
        <div className="mt-3 border-t border-gray-100 pt-3 dark:border-gray-800">
          {advanced}
        </div>
      )}
    </div>
  );
}
