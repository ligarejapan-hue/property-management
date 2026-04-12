"use client";

import { LogOut } from "lucide-react";

interface HeaderProps {
  userName: string;
  userRole: string;
  onLogout: () => void;
}

const roleBadgeStyles: Record<string, string> = {
  ADMIN: "bg-red-100 text-red-800",
  MANAGER: "bg-blue-100 text-blue-800",
  OPERATOR: "bg-green-100 text-green-800",
  VIEWER: "bg-gray-100 text-gray-800",
};

const roleLabels: Record<string, string> = {
  ADMIN: "管理者",
  MANAGER: "マネージャー",
  OPERATOR: "オペレーター",
  VIEWER: "閲覧者",
};

export default function Header({ userName, userRole, onLogout }: HeaderProps) {
  const badgeStyle = roleBadgeStyles[userRole] ?? "bg-gray-100 text-gray-800";
  const roleLabel = roleLabels[userRole] ?? userRole;

  return (
    <header className="flex h-14 shrink-0 items-center justify-between border-b border-gray-200 bg-white px-4 lg:px-6">
      <h1 className="text-lg font-bold text-gray-800 pl-10 lg:pl-0">
        物件管理システム
      </h1>

      <div className="flex items-center gap-4">
        <div className="flex items-center gap-2">
          <span className="text-sm text-gray-700">{userName}</span>
          <span
            className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${badgeStyle}`}
          >
            {roleLabel}
          </span>
        </div>
        <button
          onClick={onLogout}
          className="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm text-gray-600 transition-colors hover:bg-gray-100 hover:text-gray-900"
          title="ログアウト"
        >
          <LogOut className="h-4 w-4" />
          <span className="hidden sm:inline">ログアウト</span>
        </button>
      </div>
    </header>
  );
}
