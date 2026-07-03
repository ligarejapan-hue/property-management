"use client";

import Link from "next/link";
import { useState } from "react";
import {
  Building2,
  Building,
  Users,
  Shield,
  FileText,
  HelpCircle,
  ClipboardList,
  History,
  Menu,
  X,
  ChevronDown,
  ChevronRight,
  Upload,
  KeyRound,
  UserCog,
  MapPinned,
  Map as MapIcon,
  ScanSearch,
  ScanText,
  ClipboardCheck,
  FileSearch,
} from "lucide-react";
import { ThemeToggle } from "@/components/theme/theme-toggle";

interface SidebarProps {
  userRole: string;
  currentPath: string;
}

interface NavItem {
  label: string;
  href: string;
  icon: React.ReactNode;
}

const mainNavItems: NavItem[] = [
  {
    label: "物件一覧",
    href: "/properties",
    icon: <Building2 className="h-5 w-5" />,
  },
  {
    label: "マンション棟",
    href: "/buildings",
    icon: <Building className="h-5 w-5" />,
  },
  {
    label: "現地調査マップ",
    href: "/field-survey/map",
    icon: <MapIcon className="h-5 w-5" />,
  },
  {
    label: "巡回履歴",
    href: "/field-survey/sessions",
    icon: <History className="h-5 w-5" />,
  },
  {
    label: "受付帳CSV取込",
    href: "/import",
    icon: <Upload className="h-5 w-5" />,
  },
  {
    label: "謄本PDF取込",
    href: "/import/registry-pdf",
    icon: <FileText className="h-5 w-5" />,
  },
  {
    label: "ヘルプ",
    href: "/help",
    icon: <HelpCircle className="h-5 w-5" />,
  },
];

const adminNavItems: NavItem[] = [
  {
    label: "ユーザー管理",
    href: "/admin/users",
    icon: <Users className="h-5 w-5" />,
  },
  {
    label: "権限テンプレート",
    href: "/admin/templates",
    icon: <Shield className="h-5 w-5" />,
  },
  {
    label: "監査ログ",
    href: "/admin/audit-logs",
    icon: <ClipboardList className="h-5 w-5" />,
  },
  {
    label: "権限変更履歴",
    href: "/admin/permission-logs",
    icon: <History className="h-5 w-5" />,
  },
  {
    label: "パスワード変更",
    href: "/admin/change-password",
    icon: <KeyRound className="h-5 w-5" />,
  },
  {
    label: "所有者補正候補",
    href: "/admin/owners/correction",
    icon: <UserCog className="h-5 w-5" />,
  },
  {
    label: "表示名監査",
    href: "/admin/display-name-audit",
    icon: <ScanSearch className="h-5 w-5" />,
  },
  {
    label: "郵便番号×住所チェック",
    href: "/admin/postal-code-audit",
    icon: <MapPinned className="h-5 w-5" />,
  },
  {
    label: "テキスト衛生監査",
    href: "/admin/owners/text-hygiene",
    icon: <ScanText className="h-5 w-5" />,
  },
  {
    label: "品質監査",
    href: "/admin/owners/quality-audit",
    icon: <ClipboardCheck className="h-5 w-5" />,
  },
  {
    label: "添付検索",
    href: "/admin/attachments",
    icon: <FileSearch className="h-5 w-5" />,
  },
];

export default function Sidebar({ userRole, currentPath }: SidebarProps) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const [adminOpen, setAdminOpen] = useState(true);

  const isActive = (href: string) => {
    if (href === "/properties") {
      return currentPath === href || currentPath.startsWith("/properties/");
    }
    // Exact match for /import to avoid highlighting when on /import/owners etc.
    if (href === "/import") {
      return currentPath === "/import";
    }
    return currentPath === href || currentPath.startsWith(href + "/");
  };

  const linkClasses = (href: string) =>
    `flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors ${
      isActive(href)
        ? "bg-indigo-50 text-indigo-700 dark:bg-indigo-900 dark:text-indigo-300"
        : "text-gray-700 hover:bg-gray-100 hover:text-gray-900 dark:text-gray-300 dark:hover:bg-gray-800 dark:hover:text-gray-100"
    }`;

  const isAdmin = userRole === "admin" || userRole === "ADMIN";

  const navContent = (
    <nav className="flex flex-col gap-1 p-4">
      <div className="mb-2">
        <p className="px-3 py-1 text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
          メニュー
        </p>
      </div>
      {mainNavItems.map((item) => (
        <Link
          key={item.href}
          href={item.href}
          className={linkClasses(item.href)}
          onClick={() => setMobileOpen(false)}
        >
          {item.icon}
          {item.label}
        </Link>
      ))}

      {isAdmin && (
        <>
          <div className="mt-4 mb-1">
            <button
              onClick={() => setAdminOpen(!adminOpen)}
              className="flex w-full items-center gap-2 px-3 py-1 text-xs font-semibold uppercase tracking-wider text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
            >
              {adminOpen ? (
                <ChevronDown className="h-3 w-3" />
              ) : (
                <ChevronRight className="h-3 w-3" />
              )}
              管理者メニュー
            </button>
          </div>
          {adminOpen &&
            adminNavItems.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className={linkClasses(item.href)}
                onClick={() => setMobileOpen(false)}
              >
                {item.icon}
                {item.label}
              </Link>
            ))}
        </>
      )}
    </nav>
  );

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
        <div
          className="fixed inset-0 z-30 bg-black/30 lg:hidden"
          onClick={() => setMobileOpen(false)}
        />
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
        {/* モバイルではヘッダーからテーマ切替をここへ移動(ヘッダーの詰まり解消) */}
        <div className="shrink-0 border-t border-gray-200 dark:border-gray-700 p-4 lg:hidden">
          <div className="mb-2 text-xs font-medium text-gray-500 dark:text-gray-400">表示テーマ</div>
          <ThemeToggle />
        </div>
      </aside>
    </>
  );
}
