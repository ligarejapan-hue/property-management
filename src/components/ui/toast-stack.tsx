"use client";

/**
 * 右下のポップアップ(トースト)の見た目だけ(通知 段階1・承認済み HTML イメージ ③)。
 *
 * - PC は右下に幅 360px、スマホは下に全幅。× で閉じるまで残す(自動では消さない)。
 * - 左端の色帯で種類を示す: amber=予告 / red=外れた / green=完了 / indigo=お知らせ。
 * - 動きは出るときに少し上がるだけ。`motion-reduce` で止める。
 * - 判断はしない(何を出すかは呼び出し側)。
 */
import { CalendarClock, Check, Clock, FileCheck, Inbox, Info, LockOpen, LogOut, X } from "lucide-react";
import type { ReactNode } from "react";

export type ToastTone = "amber" | "red" | "green" | "indigo";
export type ToastIcon = "clock" | "unlock" | "logout" | "check" | "info" | "calendar" | "inbox" | "file";

export interface ToastItem {
  id: string;
  tone: ToastTone;
  icon: ToastIcon;
  title: string;
  body?: string;
  action?: ReactNode;
}

const TONE: Record<ToastTone, { border: string; icon: string }> = {
  amber: { border: "border-l-amber-500", icon: "text-amber-600 dark:text-amber-400" },
  red: { border: "border-l-red-600 dark:border-l-red-400", icon: "text-red-600 dark:text-red-400" },
  green: { border: "border-l-green-600 dark:border-l-green-400", icon: "text-green-600 dark:text-green-400" },
  indigo: { border: "border-l-indigo-500", icon: "text-indigo-500 dark:text-indigo-400" },
};

const ICONS: Record<ToastIcon, typeof Clock> = {
  clock: Clock,
  unlock: LockOpen,
  logout: LogOut,
  check: Check,
  info: Info,
  calendar: CalendarClock,
  inbox: Inbox,
  file: FileCheck,
};

export function ToastStack({ toasts, onDismiss }: { toasts: ToastItem[]; onDismiss: (id: string) => void }) {
  if (toasts.length === 0) return null;
  return (
    <div
      aria-live="polite"
      className="pointer-events-none fixed inset-x-3 bottom-3 z-50 flex flex-col gap-2 sm:inset-x-auto sm:right-4 sm:bottom-4 sm:w-[360px]"
    >
      {toasts.map((t) => {
        const tone = TONE[t.tone];
        const Icon = ICONS[t.icon];
        return (
          <div
            key={t.id}
            role="status"
            className={`pointer-events-auto flex gap-2.5 rounded-lg border border-l-4 border-gray-200 bg-white p-3 text-sm shadow-lg dark:border-gray-800 dark:bg-gray-900 ${tone.border} animate-[pm-toast-in_200ms_ease-out] motion-reduce:animate-none`}
          >
            <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${tone.icon}`} aria-hidden="true" />
            <div className="min-w-0 flex-1">
              <p className="font-bold text-gray-900 dark:text-gray-100">{t.title}</p>
              {t.body && <p className="mt-0.5 text-gray-700 dark:text-gray-300">{t.body}</p>}
              {t.action && <div className="mt-2 flex gap-2">{t.action}</div>}
            </div>
            <button
              type="button"
              onClick={() => onDismiss(t.id)}
              aria-label="閉じる"
              className="self-start rounded p-0.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-800 dark:hover:text-gray-300"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
