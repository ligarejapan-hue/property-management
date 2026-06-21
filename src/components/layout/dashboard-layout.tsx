"use client";

import { usePathname } from "next/navigation";
import { signOut, useSession } from "next-auth/react";
import Sidebar from "./sidebar";
import Header from "./header";
import { USE_MOCK } from "@/lib/api-client";
import ScreenProtectionProvider from "@/components/screen-protection/screen-protection-provider";

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const { data: session } = useSession();

  const userName = USE_MOCK ? "モック管理者" : (session?.user?.name ?? "ユーザー");
  const userRole = USE_MOCK ? "admin" : ((session?.user as { role?: string } | undefined)?.role ?? "VIEWER");

  const handleLogout = () => {
    if (USE_MOCK) return;
    signOut({ callbackUrl: "/login" });
  };

  return (
    <ScreenProtectionProvider>
      <div className="flex h-screen overflow-hidden bg-gray-50 dark:bg-gray-950">
        <Sidebar userRole={userRole} currentPath={pathname} />
        <div className="flex flex-1 flex-col overflow-hidden">
          <Header userName={userName} userRole={userRole} onLogout={handleLogout} />
          {/*
           * v2: 超ワイド画面での行の間延びを防ぐ(1536px 上限・中央寄せ)。
           * h-full は子の % 高さ(例: field-survey/map の h-full エラー表示)を
           * 従来どおり解決させるために必要。縦に長いページは main の
           * overflow-y-auto がスクロールを担う(挙動不変)。
           */}
          <main className="flex-1 overflow-y-auto p-4 lg:p-6">
            <div className="mx-auto h-full w-full max-w-[1536px]">{children}</div>
          </main>
        </div>
      </div>
    </ScreenProtectionProvider>
  );
}
