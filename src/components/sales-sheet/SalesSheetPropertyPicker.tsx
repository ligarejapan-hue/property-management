"use client";

import { Loader2, Plus, Search } from "lucide-react";
import type { PickerRow } from "@/lib/sales-sheet/picker";

export interface SalesSheetPropertyPickerProps {
  rows: PickerRow[];
  canWrite: boolean;
  keywordInput: string;
  onKeywordInputChange: (value: string) => void;
  loading: boolean;
  error: string | null;
  page: number;
  totalPages: number;
  total: number;
  onPageChange: (page: number) => void;
  onSelect: (row: PickerRow) => void;
  onOpenRegister: () => void;
}

/**
 * 販売図面ピッカーの表示部（状態レス）。データ取得・権限・ダイアログ配線は
 * /sales-sheets/new の page が担う。node SSR テスト可能に保つ。
 */
export function SalesSheetPropertyPicker({
  rows,
  canWrite,
  keywordInput,
  onKeywordInputChange,
  loading,
  error,
  page,
  totalPages,
  total,
  onPageChange,
  onSelect,
  onOpenRegister,
}: SalesSheetPropertyPickerProps) {
  return (
    <div>
      <h1 className="text-lg font-bold text-gray-900 dark:text-gray-100">販売図面を作成</h1>
      <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
        図面を作成する物件を選択してください（対象: 土地・区分マンション・戸建・一棟）
      </p>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <div className="relative min-w-[220px] flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400 dark:text-gray-500" />
          <input
            type="text"
            value={keywordInput}
            onChange={(e) => onKeywordInputChange(e.target.value)}
            placeholder="住所・地番などで検索"
            aria-label="物件を検索"
            className="w-full rounded-md border border-gray-300 bg-white py-2 pl-9 pr-3 text-sm text-gray-900 placeholder:text-gray-400 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100 dark:placeholder:text-gray-500"
          />
        </div>
        {canWrite && (
          <button
            type="button"
            onClick={onOpenRegister}
            className="flex items-center gap-1.5 whitespace-nowrap rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700"
          >
            <Plus className="h-4 w-4" />
            新しい物件を登録して作成
          </button>
        )}
      </div>

      {error && (
        <div className="mt-4 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
          {error}
        </div>
      )}

      {loading ? (
        <div className="mt-8 flex items-center justify-center gap-2 text-sm text-gray-500 dark:text-gray-400">
          <Loader2 className="h-5 w-5 animate-spin" />
          読み込み中…
        </div>
      ) : rows.length === 0 && !error ? (
        <div className="mt-8 rounded-lg border border-dashed border-gray-300 p-8 text-center text-sm text-gray-500 dark:border-gray-700 dark:text-gray-400">
          <p>対象の物件が見つかりません。</p>
          {canWrite && (
            <p className="mt-2">
              「新しい物件を登録して作成」から物件を登録すると、そのまま図面を作成できます。
            </p>
          )}
        </div>
      ) : (
        <ul className="mt-4 overflow-hidden rounded-lg border border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-900">
          {rows.map((row) => {
            const actionable = canWrite && row.kind !== null;
            const inner = (
              <>
                <span className="shrink-0 rounded-md bg-indigo-50 px-2 py-0.5 text-xs font-semibold text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300">
                  {row.typeLabel}
                </span>
                {/* 住所は行が button でも保護が効くよう、行内の明示 fragment として
                    data-pii-protected を付ける（広い container 方式は button 除外で無効・
                    sale-dm recipient-list と同方式）。 */}
                <span
                  data-pii-protected
                  data-pii-surface="property"
                  className="min-w-0 flex-1 truncate text-sm text-gray-900 dark:text-gray-100"
                >
                  {row.address}
                </span>
                <span className="hidden text-xs text-gray-400 dark:text-gray-500 sm:inline">
                  更新 {new Date(row.updatedAt).toLocaleDateString("ja-JP")}
                </span>
                {actionable && (
                  <span className="whitespace-nowrap text-xs font-semibold text-indigo-600 dark:text-indigo-400">
                    作成 →
                  </span>
                )}
              </>
            );
            return (
              <li key={row.id} className="border-b border-gray-100 last:border-b-0 dark:border-gray-800">
                {actionable ? (
                  <button
                    type="button"
                    onClick={() => onSelect(row)}
                    className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-indigo-50/60 dark:hover:bg-indigo-900/20"
                  >
                    {inner}
                  </button>
                ) : (
                  <div className="flex items-center gap-3 px-4 py-3">{inner}</div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {!loading && totalPages > 1 && (
        <div className="mt-4 flex items-center justify-center gap-3 text-sm text-gray-600 dark:text-gray-300">
          <button
            type="button"
            onClick={() => onPageChange(page - 1)}
            disabled={page <= 1}
            className="rounded-md border border-gray-300 px-3 py-1.5 hover:bg-gray-50 disabled:opacity-40 dark:border-gray-700 dark:hover:bg-gray-800"
          >
            前へ
          </button>
          <span>
            {page} / {totalPages}（全 {total} 件）
          </span>
          <button
            type="button"
            onClick={() => onPageChange(page + 1)}
            disabled={page >= totalPages}
            className="rounded-md border border-gray-300 px-3 py-1.5 hover:bg-gray-50 disabled:opacity-40 dark:border-gray-700 dark:hover:bg-gray-800"
          >
            次へ
          </button>
        </div>
      )}
    </div>
  );
}
