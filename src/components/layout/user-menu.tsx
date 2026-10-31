"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useTheme } from "next-themes";
import { ChevronDown, KeyRound, Settings2, UserCircle } from "lucide-react";
import { THEME_OPTIONS, fromNextTheme, toNextTheme, type ThemePref } from "@/lib/appearance/options";
import { THEME_SWATCHES } from "@/lib/appearance/swatches";
import { loadPreferences, saveAppearance } from "@/lib/appearance/client";

// 見た目の設定 段階4(2026-10-31): ヘッダーの利用者メニュー。色テーマだけはここからすぐ切り替える(発注者指示)。
// 文字サイズ・配置は「表示の設定」(設定 > 表示)で。選べる色は会社の設定(allowedThemes)にそろえる。
// 開閉は上部ナビと同じ作法: 外を押す・Esc(ボタンへ戻る)・リンクを押す・画面が移る で閉じる。

export const DISPLAY_SETTINGS_HREF = "/settings/display";

/** 色の小さな見本(サイドバーの色とアクセントの色)。自動はスタンダードとダークを半分ずつ。 */
export function ThemeDot({ theme }: { theme: ThemePref }) {
  const s = theme === "auto" ? null : THEME_SWATCHES[theme];
  const style = s
    ? { background: `linear-gradient(135deg, ${s.side} 0 50%, ${s.accent} 50% 100%)` }
    : { background: `linear-gradient(135deg, ${THEME_SWATCHES.standard.page} 0 50%, ${THEME_SWATCHES.dark.page} 50% 100%)` };
  return <span aria-hidden="true" className="h-4 w-4 shrink-0 rounded-full border border-line" style={style} />;
}

export default function UserMenu({ userName, currentPath }: { userName: string; currentPath: string }) {
  const { theme, setTheme } = useTheme();
  const [open, setOpen] = useState(false);
  const [allowed, setAllowed] = useState<ThemePref[] | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  // 画面が移ったら閉じる(上部ナビと同じ)
  const [prevPath, setPrevPath] = useState(currentPath);
  if (prevPath !== currentPath) {
    setPrevPath(currentPath);
    setOpen(false);
  }

  useEffect(() => {
    if (!open) return;
    // 開いたときに選べる色を読む(会社が絞っていなければ全部)。読めなければ全部を出す。
    let alive = true;
    void loadPreferences().then((d) => {
      if (alive && d) setAllowed(d.allowedThemes);
    });
    const onPointer = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setOpen(false);
      buttonRef.current?.focus();
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      alive = false;
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const current: ThemePref = fromNextTheme(theme);
  const choices = THEME_OPTIONS.filter((o) => !allowed || allowed.includes(o.value));

  return (
    <div ref={rootRef} className="relative">
      {/* data-ui=raw: ヘッダーの利用者メニューの開閉(ボタンの形ではない) */}
      <button
        ref={buttonRef}
        data-ui="raw"
        type="button"
        aria-expanded={open}
        aria-controls="user-menu-panel"
        aria-label={`${userName}のメニュー(色テーマ・表示の設定)`}
        title="色テーマ・表示の設定"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 rounded-md px-2 py-1.5 text-sm text-gray-700 transition-colors hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800"
      >
        <UserCircle className="h-5 w-5" aria-hidden="true" />
        <span className="hidden max-w-[10rem] truncate md:inline">{userName}</span>
        <ChevronDown
          className={`hidden h-4 w-4 text-fg-3 transition-transform motion-reduce:transition-none sm:block ${open ? "rotate-180" : ""}`}
          aria-hidden="true"
        />
      </button>
      {open && (
        <div
          id="user-menu-panel"
          // スマホの幅ではボタンが中ほどにあり、ボタンの右端にそろえると左へはみ出す(390px で実測)→ 画面の両端に合わせる
          className="fixed left-3 right-3 top-14 z-50 mt-1 rounded-md border border-line bg-surface p-2 shadow-lg sm:absolute sm:left-auto sm:right-0 sm:top-full sm:w-64"
        >
          <fieldset>
            <legend className="px-2 pb-1 pt-0.5 text-xs font-semibold text-fg-3">色テーマ</legend>
            {choices.map((o) => (
              <label
                key={o.value}
                className={`flex min-h-[36px] cursor-pointer items-center gap-2 rounded-md px-2 text-sm has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-accent ${
                  current === o.value ? "bg-accent-soft text-accent-text" : "text-fg hover:bg-surface-2"
                }`}
              >
                <input
                  type="radio"
                  name="user-menu-theme"
                  value={o.value}
                  checked={current === o.value}
                  onChange={() => {
                    setTheme(toNextTheme(o.value));
                    void saveAppearance({ theme: o.value });
                  }}
                  className="sr-only"
                />
                <ThemeDot theme={o.value} />
                <span className="flex-1">{o.label}</span>
                {current === o.value && <span className="text-xs">選択中</span>}
              </label>
            ))}
          </fieldset>
          <div className="mt-1 border-t border-line pt-1">
            <Link
              href={DISPLAY_SETTINGS_HREF}
              onClick={() => setOpen(false)}
              className="flex min-h-[36px] items-center gap-2 rounded-md px-2 text-sm text-fg hover:bg-surface-2"
            >
              <Settings2 className="h-4 w-4 text-fg-3" aria-hidden="true" />
              表示の設定(文字サイズ・配置)
            </Link>
            {/* スマホの幅ではヘッダーの鍵の絵を出さないので、ここから(広い画面では両方にある) */}
            <Link
              href="/admin/change-password"
              onClick={() => setOpen(false)}
              className="flex min-h-[36px] items-center gap-2 rounded-md px-2 text-sm text-fg hover:bg-surface-2 sm:hidden"
            >
              <KeyRound className="h-4 w-4 text-fg-3" aria-hidden="true" />
              パスワード変更
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}
