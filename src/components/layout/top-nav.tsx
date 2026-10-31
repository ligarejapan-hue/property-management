"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import { visibleSidebar, isNavItemActive, type NavLeaf } from "./sidebar-model";
import { topNavEntries, isTopEntryActive, menuAlignRight, type TopNavEntry } from "./top-nav-model";
import { useNavHash } from "./use-nav-hash";

// 見た目の設定 段階3(2026-10-31): 上部ナビ。項目は左メニューと同じ定義から作る(top-nav-model)。
// 出すのは広い画面で「上部ナビ」を選んだ人だけ(globals.css の [data-shell="topnav"])。
// スマホ・タブレットの幅では、どちらの設定でも今までのメニュー(左上の ≡)を使う。
// 色はサイドバーと同じ side-* の名前(テーマごとにメニューの帯の色が付く)。

interface TopNavProps {
  userRole: string;
  currentPath: string;
}

const entryClass = (active: boolean) =>
  `flex items-center gap-1.5 whitespace-nowrap rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
    active
      ? "bg-side-active-bg text-side-active-text"
      : "text-side-text hover:bg-side-hover-bg hover:text-side-hover-text"
  }`;

export default function TopNav({ userRole, currentPath }: TopNavProps) {
  const entries = topNavEntries(visibleSidebar(userRole));
  const { hash, setFromHref } = useNavHash(currentPath);
  const [openKey, setOpenKey] = useState<string | null>(null);
  // 開いたメニューを右にそろえるか(右に入りきらないときだけ)。開くときにボタンの位置で決める。
  const [alignRight, setAlignRight] = useState(false);
  const navRef = useRef<HTMLElement>(null);

  const toggleMenu = (key: string, button: HTMLButtonElement) => {
    if (openKey === key) {
      setOpenKey(null);
      return;
    }
    // 文字サイズの設定で rem が変わるので、今の html の文字の大きさで計る。
    const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
    setAlignRight(menuAlignRight(button.getBoundingClientRect().left, rem, document.documentElement.clientWidth));
    setOpenKey(key);
  };

  // 画面が移ったら開いているメニューを閉じる(戻る・進むなど、項目を押さない移動も含む)。
  const [prevPath, setPrevPath] = useState(currentPath);
  if (prevPath !== currentPath) {
    setPrevPath(currentPath);
    setOpenKey(null);
  }

  // 開いている間だけ: 外を押したら閉じる・Esc で閉じて、開いたボタンに戻る。
  useEffect(() => {
    if (!openKey) return;
    const onPointer = (e: PointerEvent) => {
      if (navRef.current && !navRef.current.contains(e.target as Node)) setOpenKey(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const btn = navRef.current?.querySelector<HTMLButtonElement>(`button[data-menu="${openKey}"]`);
      setOpenKey(null);
      btn?.focus();
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [openKey]);

  const renderLeaf = (item: NavLeaf, opts: { label?: string; icon?: React.ReactNode; inMenu?: boolean }) => {
    const active = isNavItemActive(item.href, currentPath, hash);
    const label = opts.label ?? item.label;
    const icon = opts.icon ?? item.icon;
    const cls = opts.inMenu
      ? `flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors ${
          active
            ? "bg-side-active-bg text-side-active-text"
            : "text-side-text hover:bg-side-hover-bg hover:text-side-hover-text"
        }`
      : entryClass(active);
    // 帯の上の絵は広い画面だけ(1024px 前後の幅でも1行に収める)。
    const iconEl = icon ? <span className={opts.inMenu ? "contents" : "hidden xl:contents"}>{icon}</span> : null;
    const aria = active ? ("page" as const) : undefined;
    return item.external ? (
      <a
        key={item.href}
        href={item.href}
        target={item.windowName ?? "_blank"}
        // 名前付きの窓(受付の窓)に noopener を付けると同じ窓を探せない(sidebar.tsx と同じ)。
        rel={item.windowName ? undefined : "noopener noreferrer"}
        className={cls}
        onClick={() => setOpenKey(null)}
      >
        {iconEl}
        {label}
      </a>
    ) : (
      <Link
        key={item.href}
        href={item.href}
        className={cls}
        aria-current={aria}
        onClick={() => {
          setOpenKey(null);
          setFromHref(item.href);
        }}
      >
        {iconEl}
        {label}
      </Link>
    );
  };

  const renderEntry = (e: TopNavEntry) => {
    if (e.kind === "link") return <li key={e.key}>{renderLeaf(e.item, { label: e.label, icon: e.icon })}</li>;
    const open = openKey === e.key;
    const here = isTopEntryActive(e, currentPath, hash);
    const panelId = `topnav-menu-${e.key}`;
    return (
      <li key={e.key} className="relative">
        {/* data-ui=raw: メニューの帯の開閉(ボタンの形ではない) */}
        <button
          data-ui="raw"
          data-menu={e.key}
          type="button"
          aria-expanded={open}
          aria-controls={panelId}
          onClick={(ev) => toggleMenu(e.key, ev.currentTarget)}
          className={entryClass(here)}
        >
          {e.icon && <span className="hidden xl:contents">{e.icon}</span>}
          {e.label}
          <ChevronDown
            className={`h-4 w-4 text-side-icon transition-transform motion-reduce:transition-none ${open ? "rotate-180" : ""}`}
          />
        </button>
        {open && (
          <div
            id={panelId}
            // 右に入りきらないメニューは右にそろえる(画面の外へはみ出して横スクロールを出さない)。
            // 狭い幅で2行に折り返したときは「その他」が左端に来るので、位置で決める(何番目かでは決めない)。
            // 長いメニュー(その他=最大17項目)は画面の高さで止めて中を縦に送る(枠の外は切れて押せないため)。
            className={`absolute ${alignRight ? "right-0" : "left-0"} top-full z-40 mt-1 max-h-[calc(100dvh-9rem)] w-64 max-w-[calc(100vw-2rem)] overflow-y-auto overscroll-contain rounded-md border border-side-line bg-side-bg p-1 shadow-lg`}
          >
            {e.sections.map((s, i) => (
              <div key={s.label ?? i} className={i > 0 ? "mt-1 border-t border-side-line pt-1" : undefined}>
                {s.label && (
                  <p className="px-3 pt-1.5 text-xs font-semibold tracking-wider text-side-muted">{s.label}</p>
                )}
                {s.description && (
                  <p className="px-3 pt-0.5 pb-1 text-[11px] leading-snug text-side-faint">{s.description}</p>
                )}
                {s.items.map((item) => renderLeaf(item, { inMenu: true }))}
              </div>
            ))}
          </div>
        )}
      </li>
    );
  };

  return (
    <nav
      ref={navRef}
      data-shell="topnav"
      aria-label="メインメニュー"
      className="hidden shrink-0 border-b border-side-line bg-side-bg px-4 lg:block lg:px-6"
    >
      {/* flex-wrap: 幅が足りないときは2行になる(横スクロールにしない・開いたメニューが切れない) */}
      <ul className="flex flex-wrap items-center gap-1 py-1.5">{entries.map(renderEntry)}</ul>
    </nav>
  );
}
