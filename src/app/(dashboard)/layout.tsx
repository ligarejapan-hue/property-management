import { SessionProvider } from "next-auth/react";
import DashboardLayout from "@/components/layout/dashboard-layout";
import { IdleSessionGuard } from "@/components/auth/idle-session-guard";
import { NoticeProvider } from "@/components/notifications/notice-provider";

export default function DashboardRouteLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <SessionProvider>
      {/* 通知 段階1: ベル・右下のポップアップ・OS の通知の土台(設計書 §4)。 */}
      <NoticeProvider>
        {/* 無操作1時間でログアウト・操作中は延長(スライド式)。@codex #290 P2 対応。
            55分で予告(N3)を出すため NoticeProvider の内側に置く。 */}
        <IdleSessionGuard />
        <DashboardLayout>{children}</DashboardLayout>
      </NoticeProvider>
    </SessionProvider>
  );
}
