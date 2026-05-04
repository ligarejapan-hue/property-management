"use client";

import Link from "next/link";
import { useState } from "react";
import {
  Building2,
  Building,
  Users,
  Users2,
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
} from "lucide-react";

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
    label: "受付帳CSV取込",
    href: "/import",
    icon: <Upload className="h-5 w-5" />,
  },
  {
    label: "所有者CSV取込",
    href: "/import/owners",
    icon: <Users2 className="h-5 w-5" />,
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
        ? "bg-blue-100 text-blue-800"
        : "text-gray-700 hover:bg-gray-100 hover:text-gray-900"
    }`;

  const isAdmin = userRole === "admin" || userRole === "ADMIN";

  const navContent = (
    <nav className="flex flex-col gap-1 p-4">
      <div className="mb-2">
        <p className="px-3 py-1 text-xs font-semibold uppercase tracking-wider text-gray-500">
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
              className="flex w-full items-center gap-2 px-3 py-1 text-xs font-semibold uppercase tracking-wider text-gray-500 hover:text-gray-700"
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
        className="fixed top-3 left-3 z-50 rounded-md bg-white p-2 shadow-md lg:hidden"
        aria-label="メニューを開く"
      >
        {mobileOpen ? (
          <X className="h-5 w-5 text-gray-700" />
        ) : (
          <Menu className="h-5 w-5 text-gray-700" />
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
        className={`fixed inset-y-0 left-0 z-40 w-60 transform border-r border-gray-200 bg-white transition-transform duration-200 lg:static lg:translate-x-0 ${
          mobileOpen ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <div className="flex h-14 items-center border-b border-gray-200 px-4">
          <FileText className="mr-2 h-5 w-5 text-blue-600" />
          <span className="text-sm font-bold text-gray-800">物件管理</span>
        </div>
        <div className="overflow-y-auto">{navContent}</div>
      </aside>
    </>
  );
}
