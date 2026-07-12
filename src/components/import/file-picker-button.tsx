"use client";

import { type ChangeEvent } from "react";
import { Upload } from "lucide-react";

/**
 * はっきり押せるファイル選択ボタン + 選択中ファイル名 + 対応形式の明示。
 * ブラウザ標準の素の <input type=file> は視認性が低いため、既存の
 * 「hidden input + ラベルボタン」パターンで包む(登記DM取込 Step1/2 用)。
 * onChange は呼び出し側のロジック(readFileForImport 等)へそのまま渡す。
 */
export default function FilePickerButton({
  accept,
  onChange,
  fileName,
  label = "ファイルを選択",
  hint,
  disabled,
  multiple,
}: {
  accept: string;
  onChange: (e: ChangeEvent<HTMLInputElement>) => void;
  fileName?: string | null;
  label?: string;
  hint?: string;
  disabled?: boolean;
  /** 複数ファイル選択を許可するか(既定 undefined=単一選択・後方互換)。 */
  multiple?: boolean;
}) {
  return (
    <div data-file-picker className="space-y-1">
      <div className="flex flex-wrap items-center gap-3">
        <label
          className={`inline-flex items-center gap-2 rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 focus-within:ring-2 focus-within:ring-indigo-500 dark:border-gray-600 dark:text-gray-200 ${
            disabled
              ? "cursor-not-allowed opacity-50"
              : "cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-700"
          }`}
        >
          <Upload aria-hidden="true" className="h-4 w-4" />
          {label}
          {/* sr-only = 視覚的に隠すが Tab で到達可(display:none の hidden と違い
              キーボード操作を維持)。Enter/Space で標準のファイル選択が開く。 */}
          <input
            type="file"
            accept={accept}
            disabled={disabled}
            onChange={onChange}
            multiple={multiple}
            className="sr-only"
          />
        </label>
        <span
          className={
            fileName
              ? "text-sm text-gray-900 dark:text-gray-100 break-all"
              : "text-sm text-gray-500 dark:text-gray-400"
          }
        >
          {fileName || "未選択"}
        </span>
      </div>
      {hint && <p className="text-xs text-gray-500 dark:text-gray-400">{hint}</p>}
    </div>
  );
}
