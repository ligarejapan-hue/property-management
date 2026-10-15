"use client";

/**
 * ボタンを押すと開く小さな操作メニュー(画面すっきり化 第3回・発注者決定 2026-10-16)。
 *
 * 物件の画面の「その他 ▾」・物件一覧の「出力 ▾」で使う。たまにしか使わない操作を
 * 1つのボタンの中へまとめ、いつも見えるボタンの数を減らすための部品。
 *   - 項目が0件なら**ボタンごと出さない**(押しても空のメニューが開くだけになるため)
 *   - 外側を押す・Escape・項目を選ぶ、で閉じる
 *   - 項目は「押す操作(onSelect)」か「画面を開くリンク(href)」のどちらか
 */
import { useEffect, useRef, useState, type ComponentType } from "react";
import Link from "next/link";
import { ChevronDown, Loader2 } from "lucide-react";

export interface MenuItem {
  key: string;
  label: string;
  icon?: ComponentType<{ className?: string }>;
  /** 画面を開く項目。onSelect と同時には使わない。 */
  href?: string;
  onSelect?: () => void;
  disabled?: boolean;
  /** 処理中の印(くるくる)を出す。 */
  busy?: boolean;
  /** 取り消せない操作(削除など)は赤で出す。 */
  danger?: boolean;
  title?: string;
}

export interface MenuButtonProps {
  label: string;
  items: MenuItem[];
  icon?: ComponentType<{ className?: string }>;
  /** メニューを右端そろえで開く(画面の右側に置くボタン用)。既定は true。 */
  alignRight?: boolean;
  className?: string;
}

export function MenuButton({ label, items, icon: Icon, alignRight = true, className }: MenuButtonProps) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (items.length === 0) return null;

  const itemClass = (item: MenuItem) =>
    "flex w-full items-center gap-2 whitespace-nowrap px-3 py-2 text-left text-sm disabled:cursor-not-allowed disabled:opacity-50 " +
    (item.danger
      ? "text-red-700 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/40"
      : "text-gray-700 hover:bg-gray-50 dark:text-gray-200 dark:hover:bg-gray-800");

  return (
    <div ref={wrapRef} className={`relative${className ? ` ${className}` : ""}`}>
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 whitespace-nowrap rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-200 dark:hover:bg-gray-800"
      >
        {Icon && <Icon className="h-4 w-4" />}
        {label}
        <ChevronDown className="h-4 w-4" />
      </button>
      {open && (
        <div
          role="menu"
          aria-label={label}
          className={`absolute z-30 mt-1 min-w-[12rem] overflow-hidden rounded-md border border-gray-200 bg-white py-1 shadow-lg dark:border-gray-700 dark:bg-gray-900 ${alignRight ? "right-0" : "left-0"}`}
        >
          {items.map((item) => {
            const ItemIcon = item.busy ? Loader2 : item.icon;
            const content = (
              <>
                {ItemIcon && <ItemIcon className={`h-4 w-4 shrink-0${item.busy ? " animate-spin" : ""}`} />}
                {item.label}
              </>
            );
            if (item.href) {
              return (
                <Link
                  key={item.key}
                  href={item.href}
                  role="menuitem"
                  title={item.title}
                  onClick={() => setOpen(false)}
                  className={itemClass(item)}
                >
                  {content}
                </Link>
              );
            }
            return (
              <button
                key={item.key}
                type="button"
                role="menuitem"
                title={item.title}
                disabled={item.disabled || item.busy}
                onClick={() => {
                  setOpen(false);
                  item.onSelect?.();
                }}
                className={itemClass(item)}
              >
                {content}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
