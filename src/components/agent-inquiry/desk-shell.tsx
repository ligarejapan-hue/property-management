"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useSession } from "next-auth/react";
import { USE_MOCK } from "@/lib/api-client";
import { DESK_WINDOW_NAME, windowNameFor } from "@/lib/agent-inquiry/main-view";

type ShellStatus = "loading" | "authenticated" | "unauthenticated";

/** 画面(page)が読み込んだ未対応件数を枠へ渡すイベント名(枠は自分では取得しない)。 */
export const DESK_OPEN_COUNT_EVENT = "pm-agent-desk-open-count";

/**
 * 窓の中のタブ(発注者決定 2026-10-15)。業者の名簿はメインの左メニューから外し、ここから開く。
 * ⚠名簿の URL は /agents のまま(既存のリンク・ブックマークを切らない)。
 */
export const DESK_TABS = [
  { href: "/inquiry-desk", label: "反響の受付" },
  { href: "/agents", label: "業者の名簿" },
] as const;

/** いま見ている画面がどのタブか(名簿は業者1件の画面 /agents/<id> も含む)。 */
export function activeDeskTab(pathname: string): string {
  return pathname === "/agents" || pathname.startsWith("/agents/") ? "/agents" : "/inquiry-desk";
}

/** 見た目だけ(テスト用に切り出し)。読み込み中/セッション切れの扱いはメイン画面の枠と同じ。 */
export function DeskShellView({
  status,
  userName,
  openCount,
  pathname,
  children,
}: {
  status: ShellStatus;
  userName: string;
  openCount: number | null;
  pathname: string;
  children: React.ReactNode;
}) {
  if (status === "loading") {
    return (
      <div className="flex h-screen items-center justify-center bg-gray-50 dark:bg-gray-950">
        <div className="flex flex-col items-center gap-3 text-gray-500 dark:text-gray-400">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-gray-300 border-t-teal-600 dark:border-gray-700" />
          <p className="text-sm">読み込み中…</p>
        </div>
      </div>
    );
  }
  if (status === "unauthenticated") {
    return (
      <div className="flex h-screen items-center justify-center bg-gray-50 p-6 dark:bg-gray-950">
        <div className="w-full max-w-sm rounded-lg border border-gray-200 bg-white p-6 text-center shadow-sm dark:border-gray-800 dark:bg-gray-900">
          <p className="mb-1 text-base font-semibold text-gray-900 dark:text-gray-100">セッションが切れました</p>
          <p className="mb-4 text-sm text-gray-500 dark:text-gray-400">ログインし直してください。</p>
          <a
            href={`/login?callbackUrl=${encodeURIComponent(pathname)}`}
            className="inline-block rounded-md bg-teal-700 px-4 py-2 text-sm font-medium text-white hover:bg-teal-600"
          >
            ログイン画面へ
          </a>
        </div>
      </div>
    );
  }
  return (
    <div className="min-h-screen bg-gray-50 text-gray-900 dark:bg-gray-950 dark:text-gray-100">
      <header className="sticky top-0 z-20 flex items-center justify-between bg-teal-700 px-4 py-2 text-white">
        <nav aria-label="受付の窓" className="flex items-center gap-1">
          {DESK_TABS.map((t) => {
            const on = activeDeskTab(pathname) === t.href;
            return (
              <Link
                key={t.href}
                href={t.href}
                aria-current={on ? "page" : undefined}
                className={`rounded-md px-3 py-1 text-sm font-bold ${on ? "bg-white text-teal-800" : "text-white/85 hover:bg-white/15"}`}
              >
                {t.label}
              </Link>
            );
          })}
        </nav>
        <p className="text-xs">
          {userName}
          {openCount != null && <span className="ml-2 rounded bg-white/20 px-2 py-0.5">未対応 {openCount}件</span>}
        </p>
      </header>
      <main className="mx-auto max-w-5xl p-3 sm:p-4">{children}</main>
    </div>
  );
}

function useOpenCount() {
  const [n, setN] = useState<number | null>(null);
  useEffect(() => {
    // null=件数を消す(権限が外れた・中身を出していない)。
    const on = (e: Event) => setN((e as CustomEvent<number | null>).detail);
    window.addEventListener(DESK_OPEN_COUNT_EVENT, on);
    return () => window.removeEventListener(DESK_OPEN_COUNT_EVENT, on);
  }, []);
  return n;
}

export default function DeskShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname() ?? "/inquiry-desk";
  const { data: session, status } = useSession();
  const openCount = useOpenCount();
  // ブックマークから直接開いた窓は名前が空。メイン画面の「反響の受付」がこの窓に開くよう名乗る。
  useEffect(() => {
    const name = windowNameFor(window.name, DESK_WINDOW_NAME);
    if (name) window.name = name;
  }, []);
  return (
    <DeskShellView
      status={USE_MOCK ? "authenticated" : status}
      userName={USE_MOCK ? "モック管理者" : (session?.user?.name ?? "")}
      openCount={openCount}
      pathname={pathname}
    >
      {children}
    </DeskShellView>
  );
}
