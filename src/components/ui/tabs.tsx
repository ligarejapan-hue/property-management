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
"use client";

import { useRef, type KeyboardEvent, type ReactNode } from "react";

export interface TabItem<K extends string = string> {
  key: K;
  label: ReactNode;
}

export interface TabsProps<K extends string = string> {
  tabs: readonly TabItem<K>[];
  active: K;
  onChange: (key: K) => void;
  /**
   * タブとパネルを紐付ける id の元(@codex #406 R3 P2)。ボタンは
   * {idBase}-tab-{key} / aria-controls={idBase}-panel-{key} を名乗るので、
   * 切り替わる中身のコンテナに tabPanelProps(idBase, activeKey) を貼ること。
   */
  idBase: string;
  className?: string;
}

/**
 * タブが制御する**パネル側**に貼る属性(role/id/aria-labelledby)。
 * 貼らないと支援技術は「どのタブがどの領域を切り替えるのか」を辿れない。
 * 使い方: <div {...tabPanelProps("owner-quality", tab)} className="...">
 */
export function tabPanelProps<K extends string>(idBase: string, key: K) {
  return {
    role: "tabpanel" as const,
    id: `${idBase}-panel-${key}`,
    "aria-labelledby": `${idBase}-tab-${key}`,
  };
}

export function Tabs<K extends string = string>({
  tabs,
  active,
  onChange,
  idBase,
  className,
}: TabsProps<K>) {
  const listRef = useRef<HTMLDivElement>(null);
  // ⚠role="tab" を名乗る以上、ARIA の tab パターンどおりに動かす(@codex #406 R1 P2):
  //   roving tabIndex(Tab キーではタブ群を1つとして通過)+矢印キーで移動と選択。
  //   看板だけ掲げて矢印が効かないと、支援技術の利用者には「壊れたタブ」になる。
  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const idx = tabs.findIndex((t) => t.key === active);
    let next = -1;
    if (e.key === "ArrowRight") next = (idx + 1) % tabs.length;
    else if (e.key === "ArrowLeft") next = (idx - 1 + tabs.length) % tabs.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = tabs.length - 1;
    if (next < 0 || next === idx) return;
    e.preventDefault();
    onChange(tabs[next].key);
    const btns = listRef.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]');
    btns?.[next]?.focus();
  };
  return (
    <div
      ref={listRef}
      role="tablist"
      onKeyDown={handleKeyDown}
      className={`flex flex-wrap border-b border-gray-200 dark:border-gray-800${className ? ` ${className}` : ""}`}
    >
      {tabs.map((t) => (
        <button
          key={t.key}
          id={`${idBase}-tab-${t.key}`}
          type="button"
          role="tab"
          aria-selected={active === t.key}
          aria-controls={`${idBase}-panel-${t.key}`}
          tabIndex={active === t.key ? 0 : -1}
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
