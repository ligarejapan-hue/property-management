import { SessionProvider } from "next-auth/react";
import DashboardLayout from "@/components/layout/dashboard-layout";
import { IdleSessionGuard } from "@/components/auth/idle-session-guard";

export default function DashboardRouteLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <SessionProvider>
      {/* 無操作1時間でログアウト・操作中は延長(スライド式)。@codex #290 P2 対応。 */}
      <IdleSessionGuard />
      <DashboardLayout>{children}</DashboardLayout>
    </SessionProvider>
  );
}
