"use client";

/**
 * 取り込みの画面の「入れたファイル」の欄(2026-10-28 第2段)。
 * ファイルを入れる枠は「ファイルを入れる」1つにまとめたので、ここでは入れたファイルを見せるだけ。
 * 入っていなければ「ファイルを入れる」へ案内する(発注者決定: 古い画面の枠は外す)。
 */
import Link from "next/link";
import { FileText, Upload, X } from "lucide-react";

export default function HandedFileSlot({
  fileLabel,
  onClear,
  disabled = false,
  className = "",
}: {
  /** 入っているファイルの表示名(無ければ null)。 */
  fileLabel: string | null;
  /** 「外す」を押したとき(渡さなければ出さない)。 */
  onClear?: () => void;
  disabled?: boolean;
  className?: string;
}) {
  if (fileLabel === null) {
    return (
      <div
        className={`flex flex-wrap items-center justify-between gap-3 rounded-lg border border-dashed border-gray-300 bg-gray-50 p-4 text-sm text-gray-600 dark:border-gray-700 dark:bg-gray-900/40 dark:text-gray-300 ${className}`}
      >
        <span>ファイルは「ファイルを入れる」から入れてください。中身を見分けて、この画面に持ってきます。</span>
        <Link
          href="/import/drop"
          className="inline-flex items-center gap-1.5 rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700"
        >
          <Upload className="h-4 w-4" aria-hidden="true" />
          ファイルを入れる
        </Link>
      </div>
    );
  }
  return (
    <div
      className={`flex flex-wrap items-center justify-between gap-3 rounded-lg border border-indigo-200 bg-indigo-50 p-4 text-sm text-indigo-900 dark:border-indigo-800 dark:bg-indigo-950/40 dark:text-indigo-100 ${className}`}
    >
      <span className="flex min-w-0 items-center gap-2">
        <FileText className="h-5 w-5 shrink-0" aria-hidden="true" />
        <span className="truncate font-medium">{fileLabel}</span>
      </span>
      <span className="flex items-center gap-3">
        {onClear && (
          <button
            type="button"
            onClick={onClear}
            disabled={disabled}
            className="inline-flex items-center gap-1 text-xs text-indigo-700 underline disabled:opacity-50 dark:text-indigo-300"
          >
            <X className="h-3.5 w-3.5" aria-hidden="true" />
            外す
          </button>
        )}
        <Link href="/import/drop" className="text-xs text-indigo-700 underline dark:text-indigo-300">
          別のファイルを入れる
        </Link>
      </span>
    </div>
  );
}
