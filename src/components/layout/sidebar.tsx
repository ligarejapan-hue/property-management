"use client";

import Link from "next/link";
import { useState } from "react";
import { ChevronDown, ChevronRight, Menu, X, FileText } from "lucide-react";
import { ThemeToggle } from "@/components/theme/theme-toggle";
import { visibleSidebar, isNavItemActive, type NavGroup, type NavLeaf } from "./sidebar-model";

interface SidebarProps {
  userRole: string;
  currentPath: string;
}

export default function Sidebar({ userRole, currentPath }: SidebarProps) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const groups = visibleSidebar(userRole);

  const isActive = (href: string) => isNavItemActive(href, currentPath);

  // 折りたたみグループの開閉: 手動トグル(未操作=未設定)が無ければ、現在地がグループ内なら
  // 自動で開く。dashboard layout は永続で Sidebar が再マウントされないため、遷移のたび
  // 導出することで現在地に追従する(effect 不要=react-hooks/set-state-in-effect も踏まない)。
  const [openMap, setOpenMap] = useState<Record<string, boolean>>({});
  const isOpen = (g: NavGroup) => openMap[g.key] ?? g.items.some((i) => isActive(i.href));

  const linkClasses = (href: string) =>
    `flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors ${
      isActive(href)
        ? "bg-indigo-50 text-indigo-700 dark:bg-indigo-900 dark:text-indigo-300"
        : "text-gray-700 hover:bg-gray-100 hover:text-gray-900 dark:text-gray-300 dark:hover:bg-gray-800 dark:hover:text-gray-100"
    }`;

  const renderLeaf = (item: NavLeaf) =>
    item.external ? (
      <a
        key={item.href}
        href={item.href}
        target="_blank"
        rel="noopener noreferrer"
        className={linkClasses(item.href)}
        onClick={() => setMobileOpen(false)}
      >
        {item.icon}
        {item.label}
      </a>
    ) : (
      <Link
        key={item.href}
        href={item.href}
        className={linkClasses(item.href)}
        onClick={() => setMobileOpen(false)}
      >
        {item.icon}
        {item.label}
      </Link>
    );

  const renderGroup = (g: NavGroup) => {
    if (!g.label) return <div key={g.key}>{g.items.map(renderLeaf)}</div>;
    if (g.collapsible) {
      const open = isOpen(g);
      return (
        <div key={g.key}>
          <div className="mt-4 mb-1">
            <button
              onClick={() => setOpenMap((m) => ({ ...m, [g.key]: !open }))}
              aria-expanded={open}
              className="flex w-full items-center gap-2 px-3 py-1 text-xs font-semibold uppercase tracking-wider text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
            >
              {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
              {g.label}
            </button>
          </div>
          {open && g.items.map(renderLeaf)}
        </div>
      );
    }
    return (
      <div key={g.key}>
        <div className="mt-4 mb-1">
          <p className="px-3 py-1 text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
            {g.label}
          </p>
        </div>
        {g.items.map(renderLeaf)}
      </div>
    );
  };

  const navContent = <nav className="flex flex-col gap-1 p-4">{groups.map(renderGroup)}</nav>;

  return (
    <>
      {/* Mobile toggle button */}
      <button
        onClick={() => setMobileOpen(!mobileOpen)}
        className="fixed top-3 left-3 z-50 rounded-md bg-white dark:bg-gray-900 p-2 shadow-md lg:hidden"
        aria-label="メニューを開く"
      >
        {mobileOpen ? (
          <X className="h-5 w-5 text-gray-700 dark:text-gray-300" />
        ) : (
          <Menu className="h-5 w-5 text-gray-700 dark:text-gray-300" />
        )}
      </button>

      {/* Mobile overlay */}
      {mobileOpen && (
        <div className="fixed inset-0 z-30 bg-black/30 lg:hidden" onClick={() => setMobileOpen(false)} />
      )}

      {/* Sidebar */}
      <aside
        className={`fixed inset-y-0 left-0 z-40 flex w-60 transform flex-col border-r border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 transition-transform duration-200 lg:static lg:translate-x-0 ${
          mobileOpen ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        {/* pl-14: モバイルの固定「×」ボタン(left-3 + 36px)がタイトルに重ならない位置から始める */}
        <div className="flex h-14 shrink-0 items-center border-b border-gray-200 dark:border-gray-700 pl-14 pr-4 lg:pl-4">
          <FileText className="mr-2 h-5 w-5 text-indigo-600 dark:text-indigo-400" />
          <span className="text-sm font-bold text-gray-800 dark:text-gray-100">物件管理</span>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">{navContent}</div>
        {/* モバイルではヘッダーからテーマ切替をここへ移動。pb の env(safe-area-inset-bottom)で
            iPhone のホームインジケータに最下部操作が隠れないよう余白を確保(非対応環境では 0)。 */}
        <div className="shrink-0 border-t border-gray-200 dark:border-gray-700 p-4 pb-[calc(1rem+env(safe-area-inset-bottom))] lg:hidden">
          <div className="mb-2 text-xs font-medium text-gray-500 dark:text-gray-400">表示テーマ</div>
          <ThemeToggle />
        </div>
      </aside>
    </>
  );
}
