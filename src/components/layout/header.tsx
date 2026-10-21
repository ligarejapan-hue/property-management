"use client";

import { Button } from "@/components/ui/button";
import Link from "next/link";
import { KeyRound, LogOut } from "lucide-react";
import StatusBadge, { USER_ROLE_INTENT, type BadgeIntent } from "@/components/ui/status-badge";
import { ROLE_LABELS } from "@/lib/role-labels";
import { ThemeToggle } from "@/components/theme/theme-toggle";
import { HeaderBell } from "@/components/notifications/header-bell";

interface HeaderProps {
  userName: string;
  userRole: string;
  onLogout: () => void;
}

/**
 * 右上の役職の札(画面すっきり化 第1回・2026-10-15)。
 * ⚠セッションの role は admin/office_staff/field_staff。以前は旧ロール(ADMIN/MANAGER…)の表で
 *   引いていたため一致せず、英字のまま出ていた。ユーザー管理と同じ表(ROLE_LABELS)で引く。
 *   大文字小文字は無視(roles.ts の roleLevel と同じ扱い)。知らない値は英字を出さず「利用者」。
 */
export function headerRoleBadge(role: string): { label: string; intent: BadgeIntent } {
  const key = (role ?? "").toLowerCase();
  return {
    label: ROLE_LABELS[key] ?? "利用者",
    intent: USER_ROLE_INTENT[key] ?? "neutral",
  };
}

export default function Header({ userName, userRole, onLogout }: HeaderProps) {
  // v2: ロールは状態色(赤=エラー等)と衝突しない専用色(violet/sky/neutral)
  const { label: roleLabel, intent: roleIntent } = headerRoleBadge(userRole);

  return (
    <header className="flex h-14 shrink-0 items-center justify-between gap-2 border-b border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 px-4 lg:px-6">
      {/* pl-12: モバイルの固定ハンバーガー(left-3 + 36px)を確実に避ける。
          min-w-0 + truncate: 右側より優先して縮み、折り返さず 1 行を保つ。 */}
      <h1 className="min-w-0 truncate text-lg font-bold text-gray-800 dark:text-gray-100 pl-12 lg:pl-0">
        物件管理システム
      </h1>

      <div className="flex shrink-0 items-center gap-2 sm:gap-4">
        {/* 通知 段階1: お知らせのベル(テーマ切替の左・スマホでは役職の左) */}
        <HeaderBell />
        {/* モバイルではテーマ切替をメニュー(ドロワー)下部へ移し、ヘッダーを 1 行に保つ */}
        <div className="hidden sm:block">
          <ThemeToggle />
        </div>
        <div className="flex items-center gap-2">
          <span className="hidden md:inline text-sm text-gray-700 dark:text-gray-300">{userName}</span>
          <StatusBadge intent={roleIntent}>{roleLabel}</StatusBadge>
        </div>
        {/* パスワード変更(画面すっきり化 第1回・2026-10-15)。それまでは管理者のメニューにしか無かった。
            API(/api/me/change-password)も同日から本人の分だけ全員が使える(今のパスワードの照合は必須)。 */}
        <Link
          href="/admin/change-password"
          className="flex items-center gap-1.5 rounded-md px-2 py-1.5 text-sm text-gray-600 dark:text-gray-300 transition-colors hover:bg-gray-100 dark:hover:bg-gray-800 hover:text-gray-900 dark:hover:text-gray-100"
          title="パスワード変更"
          aria-label="パスワード変更"
        >
          <KeyRound className="h-4 w-4" />
        </Link>
        <Button
          variant="ghost"
          size="sm"
          onClick={onLogout}
          className="text-gray-600 dark:text-gray-300"
          title="ログアウト"
        >
          <LogOut className="h-4 w-4" />
          <span className="hidden sm:inline">ログアウト</span>
        </Button>
      </div>
    </header>
  );
}
