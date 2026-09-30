import { SessionProvider } from "next-auth/react";
import { IdleSessionGuard } from "@/components/auth/idle-session-guard";
import DeskShell from "@/components/agent-inquiry/desk-shell";
import ScreenProtectionProvider from "@/components/screen-protection/screen-protection-provider";

/**
 * 受付の窓(設計 2026-09-28 §2.1・方針11)。メイン画面と分けて開きっぱなしにする=メニューを出さない。
 * ログイン必須は proxy.ts(公開パスに入れていない)+各 API の getApiSession。
 */
export default function DeskRouteLayout({ children }: { children: React.ReactNode }) {
  return (
    <SessionProvider>
      {/* 無操作1時間でログアウト(メイン画面と同じ)。 */}
      <IdleSessionGuard />
      <DeskShell>
        {/* 画面保護(透かし・コピー/印刷の抑止と記録)はメイン画面と同じ(設計 §4)。 */}
        <ScreenProtectionProvider>{children}</ScreenProtectionProvider>
      </DeskShell>
    </SessionProvider>
  );
}
