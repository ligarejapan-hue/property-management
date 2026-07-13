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
  const { data: session, status } = useSession();

  // セッション取得が終わるまで/失敗して未認証になった時に、役割を "VIEWER" と誤決定しない。
  // 誤決定すると管理者が一瞬「閲覧者」に降格して管理メニューが消え、無限スピナーのようにも見える(A3 UI総点検)。
  if (!USE_MOCK && status === "loading") {
    return (
      <div className="flex h-screen items-center justify-center bg-gray-50 dark:bg-gray-950">
        <div className="flex flex-col items-center gap-3 text-gray-500 dark:text-gray-400">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-gray-300 border-t-indigo-500 dark:border-gray-700 dark:border-t-indigo-400" />
          <p className="text-sm">読み込み中…</p>
        </div>
      </div>
    );
  }
  if (!USE_MOCK && status === "unauthenticated") {
    // ログイン必須画面での未認証=セッション切れ or 取得失敗。黙って閲覧者に降格せず、再ログインへ明確に誘導する。
    return (
      <div className="flex h-screen items-center justify-center bg-gray-50 p-6 dark:bg-gray-950">
        <div className="w-full max-w-sm rounded-lg border border-gray-200 bg-white p-6 text-center shadow-sm dark:border-gray-800 dark:bg-gray-900">
          <p className="mb-1 text-base font-semibold text-gray-900 dark:text-gray-100">セッションが切れました</p>
          <p className="mb-4 text-sm text-gray-500 dark:text-gray-400">通信状況で一時的に起きることもあります。ログインし直してください。</p>
          <a
            href={`/login?callbackUrl=${encodeURIComponent(pathname ?? "/")}`}
            className="inline-block rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500"
          >
            ログイン画面へ
          </a>
        </div>
      </div>
    );
  }

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
          {/* pb-24(モバイルのみ): iOS Safari の下部ツールバーに最下部の
              コンテンツが隠れないよう、スクロール末尾に余白を確保する */}
          <main className="flex-1 overflow-y-auto p-4 pb-24 lg:p-6 lg:pb-6">
            <div className="mx-auto h-full w-full max-w-[1536px]">{children}</div>
          </main>
        </div>
      </div>
    </ScreenProtectionProvider>
  );
}
