"use client";

import Link from "next/link";
import { useState } from "react";
import { ChevronDown, ChevronRight, Menu, X, FileText } from "lucide-react";
import { ThemeToggle } from "@/components/theme/theme-toggle";
import { visibleSidebar, isNavItemActive, type NavGroup, type NavLeaf } from "./sidebar-model";
import { useNavHash } from "./use-nav-hash";
import { DISPLAY_SETTINGS_HREF } from "./user-menu";

interface SidebarProps {
  userRole: string;
  currentPath: string;
}

export default function Sidebar({ userRole, currentPath }: SidebarProps) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const groups = visibleSidebar(userRole);

  // いま見ている位置(#)。上部ナビと共通の use-nav-hash(@codex #411 R2/R4 の注意もそちら)。
  const { hash, setFromHref } = useNavHash(currentPath);

  // 押した項目そのものから位置を確定する。
  const handleNavClick = (href: string) => {
    setMobileOpen(false);
    setFromHref(href);
  };

  const isActive = (href: string) => isNavItemActive(href, currentPath, hash);

  // 折りたたみグループの開閉: 手動トグル(未操作=未設定)が無ければ、現在地がグループ内なら
  // 自動で開く。dashboard layout は永続で Sidebar が再マウントされないため、遷移のたび
  // 導出することで現在地に追従する(effect 不要=react-hooks/set-state-in-effect も踏まない)。
  const [openMap, setOpenMap] = useState<Record<string, boolean>>({});
  const isOpen = (g: NavGroup) => openMap[g.key] ?? g.items.some((i) => isActive(i.href));

  const linkClasses = (href: string) =>
    `flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors ${
      isActive(href)
        ? "bg-side-active-bg text-side-active-text"
        : "text-side-text hover:bg-side-hover-bg hover:text-side-hover-text"
    }`;

  // 中身が1つだけの柱は、見出しそのものをその画面へのリンクにする(開いても1行増えるだけのため)。
  // 文字と絵は柱のものを使う。
  const renderLeaf = (item: NavLeaf, as?: { label: string; icon?: React.ReactNode }) => {
    const icon = as?.icon ?? item.icon;
    const label = as?.label ?? item.label;
    return item.external ? (
      <a
        key={item.href}
        href={item.href}
        target={item.windowName ?? "_blank"}
        // 名前付きの窓(受付の窓)に noopener を付けると、ブラウザが同じ名前の窓を探せず毎回新しい窓になる。
        // 同じサイトの画面なので付けなくてよい。資料(_blank)は従来どおり付ける。
        rel={item.windowName ? undefined : "noopener noreferrer"}
        className={linkClasses(item.href)}
        onClick={() => setMobileOpen(false)}
      >
        {icon}
        {label}
      </a>
    ) : (
      <Link
        key={item.href}
        href={item.href}
        className={linkClasses(item.href)}
        onClick={() => handleNavClick(item.href)}
      >
        {icon}
        {label}
      </Link>
    );
  };

  const renderGroup = (g: NavGroup) => {
    if (!g.label) return <div key={g.key}>{g.items.map((i) => renderLeaf(i))}</div>;
    if (g.pillar) {
      // 左メニューの柱(発注者決定 2026-10-15)。普段は見出しだけを並べ、押すと中が開く。
      if (g.items.length === 1) {
        return <div key={g.key}>{renderLeaf(g.items[0], { label: g.label, icon: g.icon })}</div>;
      }
      const open = isOpen(g);
      const here = g.items.some((i) => isActive(i.href));
      return (
        <div key={g.key}>
          {/* data-ui=raw: メニューの開閉見出し(幅いっぱいの行・ボタンの形ではない) */}
          <button
            data-ui="raw"
            type="button"
            onClick={() => setOpenMap((m) => ({ ...m, [g.key]: !open }))}
            aria-expanded={open}
            className={`flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors ${
              // 閉じていても、いまいる画面がこの中にあることは色で分かるようにする。
              here && !open
                ? "text-side-active-text"
                : "text-side-text hover:bg-side-hover-bg hover:text-side-hover-text"
            }`}
          >
            {g.icon}
            <span className="flex-1 text-left">{g.label}</span>
            {open ? <ChevronDown className="h-4 w-4 text-side-icon" /> : <ChevronRight className="h-4 w-4 text-side-icon" />}
          </button>
          {open && (
            <div className="mb-1 ml-4 border-l border-side-line pl-2">
              {/* 一言説明は開いたときだけ出す(閉じた並びは見出しだけにして短く保つ)。 */}
              {g.description && (
                <p className="px-3 pt-1 pb-0.5 text-[11px] leading-snug text-side-faint">
                  {g.description}
                </p>
              )}
              {g.items.map((i) => renderLeaf(i))}
            </div>
          )}
        </div>
      );
    }
    if (g.collapsible) {
      const open = isOpen(g);
      return (
        <div key={g.key}>
          <div className="mt-4 mb-1">
            {/* data-ui=raw: メニューの開閉見出し(文字だけの行・ボタンの形ではない) */}
            <button
              data-ui="raw"
              onClick={() => setOpenMap((m) => ({ ...m, [g.key]: !open }))}
              aria-expanded={open}
              className="flex w-full items-center gap-2 px-3 py-1 text-xs font-semibold uppercase tracking-wider text-side-muted hover:text-side-muted-hover"
            >
              {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
              {g.label}
            </button>
            {/* メニュー再編(2026-08-24): 名前だけでは中身が分かりにくい
                グループにだけ一言説明を出す。開閉ボタンの外に置く
                (押す的を小さくしない・読み上げでボタン名が長くならない)。 */}
            {g.description && (
              <p className="px-3 pl-8 text-[11px] leading-snug text-side-faint">
                {g.description}
              </p>
            )}
          </div>
          {open && g.items.map((i) => renderLeaf(i))}
        </div>
      );
    }
    return (
      <div key={g.key}>
        <div className="mt-4 mb-1">
          <p className="px-3 py-1 text-xs font-semibold uppercase tracking-wider text-side-muted">
            {g.label}
          </p>
          {g.description && (
            <p className="px-3 text-[11px] leading-snug text-side-faint">
              {g.description}
            </p>
          )}
        </div>
        {g.items.map((i) => renderLeaf(i))}
      </div>
    );
  };

  // 柱の並びと「今まで通り」のグループ(物件データ編集・システム管理・資料)の間に区切り線を引く。
  const navContent = (
    <nav className="flex flex-col gap-1 p-4">
      {groups.map((g, i) =>
        i > 0 && groups[i - 1].pillar && !g.pillar && g.label ? (
          <div key={`${g.key}-sep`}>
            <hr className="my-3 border-side-line" />
            {renderGroup(g)}
          </div>
        ) : (
          renderGroup(g)
        ),
      )}
    </nav>
  );

  return (
    <>
      {/* Mobile toggle button */}
      {/* data-ui=raw: スマホのメニュー開閉(アイコンだけの浮いたボタン) */}
      <button
        data-ui="raw"
        onClick={() => setMobileOpen(!mobileOpen)}
        className="fixed top-3 left-3 z-50 rounded-md bg-side-bg p-2 shadow-md lg:hidden"
        aria-label="メニューを開く"
      >
        {mobileOpen ? (
          <X className="h-5 w-5 text-side-text" />
        ) : (
          <Menu className="h-5 w-5 text-side-text" />
        )}
      </button>

      {/* Mobile overlay */}
      {mobileOpen && (
        <div className="fixed inset-0 z-30 bg-black/30 lg:hidden" onClick={() => setMobileOpen(false)} />
      )}

      {/* Sidebar(data-shell: 上部ナビを選んだ人には広い画面で出さない=globals.css。スマホのメニューはどちらでも同じこれ) */}
      <aside
        data-shell="sidebar"
        className={`fixed inset-y-0 left-0 z-40 flex w-60 transform flex-col border-r border-side-line bg-side-bg transition-transform duration-200 lg:static lg:translate-x-0 ${
          mobileOpen ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        {/* pl-14: モバイルの固定「×」ボタン(left-3 + 36px)がタイトルに重ならない位置から始める */}
        <div className="flex h-14 shrink-0 items-center border-b border-side-line pl-14 pr-4 lg:pl-4">
          <FileText className="mr-2 h-5 w-5 text-logo-bg" />
          <span className="text-sm font-bold text-side-strong">物件管理</span>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">{navContent}</div>
        {/* モバイルではヘッダーからテーマ切替をここへ移動。pb の env(safe-area-inset-bottom)で
            iPhone のホームインジケータに最下部操作が隠れないよう余白を確保(非対応環境では 0)。 */}
        <div className="shrink-0 border-t border-side-line p-4 pb-[calc(1rem+env(safe-area-inset-bottom))] lg:hidden">
          <div className="mb-2 text-xs font-medium text-side-muted">表示(色・文字サイズ)</div>
          <ThemeToggle withDensity />
          {/* 段階4: 見本付きで選べる 設定 > 表示 へ(配置もここで選ぶ) */}
          <Link
            href={DISPLAY_SETTINGS_HREF}
            onClick={() => setMobileOpen(false)}
            className="mt-2 inline-flex min-h-[36px] items-center text-sm text-side-text underline-offset-2 hover:underline"
          >
            表示の設定を開く
          </Link>
        </div>
      </aside>
    </>
  );
}
