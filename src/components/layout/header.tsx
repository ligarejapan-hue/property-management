"use client";

import { LogOut } from "lucide-react";
import StatusBadge, { ROLE_INTENT } from "@/components/ui/status-badge";
import { ThemeToggle } from "@/components/theme/theme-toggle";

interface HeaderProps {
  userName: string;
  userRole: string;
  onLogout: () => void;
}

const roleLabels: Record<string, string> = {
  ADMIN: "管理者",
  MANAGER: "マネージャー",
  OPERATOR: "オペレーター",
  VIEWER: "閲覧者",
};

export default function Header({ userName, userRole, onLogout }: HeaderProps) {
  // v2: ロールは状態色(赤=エラー等)と衝突しない専用色(violet/sky/neutral)
  const roleIntent = ROLE_INTENT[userRole] ?? "neutral";
  const roleLabel = roleLabels[userRole] ?? userRole;

  return (
    <header className="flex h-14 shrink-0 items-center justify-between border-b border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 px-4 lg:px-6">
      <h1 className="text-lg font-bold text-gray-800 dark:text-gray-100 pl-10 lg:pl-0">
        物件管理システム
      </h1>

      <div className="flex items-center gap-4">
        <ThemeToggle />
        <div className="flex items-center gap-2">
          <span className="text-sm text-gray-700 dark:text-gray-300">{userName}</span>
          <StatusBadge intent={roleIntent}>{roleLabel}</StatusBadge>
        </div>
        <button
          onClick={onLogout}
          className="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm text-gray-600 dark:text-gray-300 transition-colors hover:bg-gray-100 dark:hover:bg-gray-800 hover:text-gray-900 dark:hover:text-gray-100"
          title="ログアウト"
        >
          <LogOut className="h-4 w-4" />
          <span className="hidden sm:inline">ログアウト</span>
        </button>
      </div>
    </header>
  );
}
