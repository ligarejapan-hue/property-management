"use client";

/**
 * 自動ログオフの予告ダイアログ(N3・承認済み HTML イメージ ④)。見た目だけ。
 * 「続ける」を押すと操作したものとみなして延長される(押す操作自体を
 * `IdleSessionGuard` が活動として拾う=延長の仕組みは今のまま)。
 */
import { useEffect, useState } from "react";
import { Clock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ModalShell } from "@/components/ui/modal-shell";
import { IDLE_WARN_DIALOG_BODY, IDLE_WARN_TITLE, formatRemaining } from "@/lib/notifications/idle-warning";

export function IdleLogoutDialog({
  deadline,
  onContinue,
  onLogout,
}: {
  /** ログオフされる時刻(ms)。 */
  deadline: number;
  onContinue: () => void;
  onLogout: () => void;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);

  return (
    <ModalShell
      size="sm"
      title={IDLE_WARN_TITLE}
      onClose={onContinue}
      footer={
        <>
          <Button variant="secondary" onClick={onLogout}>
            ログアウトする
          </Button>
          <Button onClick={onContinue}>続ける</Button>
        </>
      }
    >
      <p className="text-sm leading-relaxed text-gray-700 dark:text-gray-300">{IDLE_WARN_DIALOG_BODY}</p>
      <p className="mt-3 flex items-center gap-1.5 rounded-md border border-amber-200 bg-amber-50 px-2.5 py-1.5 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
        <Clock className="h-4 w-4 shrink-0" aria-hidden="true" />
        残り {formatRemaining(deadline - now)}
      </p>
    </ModalShell>
  );
}
