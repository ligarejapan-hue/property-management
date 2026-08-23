/**
 * 検索窓 (UI一貫性 第2弾 ②・発注者承認 2026-08-23)。
 *
 * 背景: 検索窓のある8画面で位置(左/右/枠内)と幅がまちまちだった(実測)。
 * 規約: 絞り込み枠の**左端・最初**に置き、幅は sm:w-80(モバイルは全幅)。
 * 親が幅を決める画面(グリッド内等)は width="full"。
 * 見た目は物件一覧の検索窓と同一(虫めがね+rounded-md+focus indigo)。
 */
import { Search } from "lucide-react";
import type { InputHTMLAttributes } from "react";

export interface SearchFieldProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "width"> {
  /** 既定 "md"=w-full sm:w-80。"full"=常に親いっぱい。 */
  width?: "md" | "full";
}

export function SearchField({ width = "md", className, ...rest }: SearchFieldProps) {
  return (
    <div
      className={`relative ${width === "md" ? "w-full sm:w-80" : "w-full"}${className ? ` ${className}` : ""}`}
    >
      <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400 dark:text-gray-500" />
      <input
        type="text"
        className="w-full rounded-md border border-gray-300 bg-white py-2 pl-9 pr-3 text-sm text-gray-900 placeholder:text-gray-400 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100 dark:placeholder:text-gray-500"
        {...rest}
      />
    </div>
  );
}
