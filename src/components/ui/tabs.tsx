/**
 * タブ行 (UI一貫性 第3弾 ⑪・発注者承認 2026-08-23)。
 *
 * 背景: border-b-2 のタブ行が複数画面で各自実装(active 色は同系だが
 * aria が無く、hover・dark の書き方が微妙に違う)。以後のタブはこれを使う。
 * 規約: active = border-indigo-600 text-indigo-700(dark:indigo-400) /
 * 非active = border-transparent text-gray-500 / role=tab + aria-selected。
 *
 * ⚠URL リンク型のタブ(遷移でページが変わる)は対象外。これは同一ページ内の
 *   表示切替(onChange で state を替える)用。
 */
import type { ReactNode } from "react";

export interface TabItem<K extends string = string> {
  key: K;
  label: ReactNode;
}

export interface TabsProps<K extends string = string> {
  tabs: readonly TabItem<K>[];
  active: K;
  onChange: (key: K) => void;
  className?: string;
}

export function Tabs<K extends string = string>({
  tabs,
  active,
  onChange,
  className,
}: TabsProps<K>) {
  return (
    <div
      role="tablist"
      className={`flex flex-wrap border-b border-gray-200 dark:border-gray-800${className ? ` ${className}` : ""}`}
    >
      {tabs.map((t) => (
        <button
          key={t.key}
          type="button"
          role="tab"
          aria-selected={active === t.key}
          onClick={() => onChange(t.key)}
          className={`border-b-2 px-4 py-2 text-sm font-medium transition-colors ${
            active === t.key
              ? "border-indigo-600 text-indigo-700 dark:border-indigo-400 dark:text-indigo-400"
              : "border-transparent text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
          }`}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}
