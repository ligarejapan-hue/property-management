"use client";

/**
 * 右上のベルと、開いたときのお知らせパネルの見た目だけ(通知 段階1・承認済み HTML イメージ ①②)。
 *
 * - 件数の丸は赤。0件なら出さない。
 * - 未確認の行は薄い indigo の背景と右端の点。
 * - 一番下に「PC・スマホにも通知する」(許可前 / 許可済み / 拒否 / 非対応 の4状態)。
 * - 判断・保存はしない(`components/notifications/header-bell.tsx` が結線する)。
 */
import { Bell, BellOff, CalendarClock, Check, Clock, FileCheck, Inbox, LockOpen, LogOut, Smartphone } from "lucide-react";

export type NotificationPermissionView = "unsupported" | "default" | "granted" | "denied";

/** 画面を閉じていても届く通知(段階4a)の見え方。 */
export type PushView =
  | { status: "on"; deviceScope: "shared" | "personal" }
  | { status: "off" | "not_configured" | "reload_required" | "failed" | "unsupported" | "working" };

export interface NotificationPanelItem {
  id: string;
  icon: "clock" | "unlock" | "logout" | "calendar" | "inbox" | "file";
  tone: "amber" | "red" | "indigo" | "green";
  message: string;
  meta: string;
  unread: boolean;
  href?: string;
}

export function BellButton({
  unreadCount,
  open,
  onClick,
}: {
  unreadCount: number;
  open: boolean;
  onClick: () => void;
}) {
  const label = unreadCount > 0 ? `お知らせ(未確認 ${unreadCount} 件)` : "お知らせ";
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      aria-expanded={open}
      aria-haspopup="dialog"
      title="お知らせ"
      className={`relative inline-flex h-9 w-9 items-center justify-center rounded-md transition-colors ${
        open
          ? "bg-gray-100 text-gray-900 dark:bg-gray-800 dark:text-gray-100"
          : "text-gray-600 hover:bg-gray-100 hover:text-gray-900 dark:text-gray-300 dark:hover:bg-gray-800 dark:hover:text-gray-100"
      }`}
    >
      <Bell className="h-5 w-5" />
      {unreadCount > 0 && (
        <span className="absolute top-0.5 right-0.5 min-w-4 rounded-full bg-red-600 px-1 text-center text-[10px] leading-4 font-bold text-white ring-2 ring-white dark:bg-red-500 dark:ring-gray-900">
          {unreadCount > 9 ? "9+" : unreadCount}
        </span>
      )}
    </button>
  );
}

const ITEM_ICON = { clock: Clock, unlock: LockOpen, logout: LogOut, calendar: CalendarClock, inbox: Inbox, file: FileCheck } as const;
const ITEM_TONE = {
  amber: "bg-amber-50 text-amber-600 dark:bg-amber-500/10 dark:text-amber-400",
  red: "bg-red-50 text-red-600 dark:bg-red-500/10 dark:text-red-400",
  indigo: "bg-indigo-50 text-indigo-600 dark:bg-indigo-500/10 dark:text-indigo-400",
  green: "bg-green-50 text-green-700 dark:bg-green-500/10 dark:text-green-400",
} as const;

/** 許可済みのときの「画面を閉じていても届くか」の一言と「この端末は自分専用」の選択(段階4a・D18)。 */
function PushStatusLine({ push, onDeviceScopeChange }: { push: PushView; onDeviceScopeChange?: (scope: "shared" | "personal") => void }) {
  if (push.status === "on") {
    return (
      <div className="mt-2">
        <p>
          {push.deviceScope === "personal"
            ? "画面を閉じていても届きます（最後のログインから30日）。"
            : "画面を閉じていても届きます（閉じてから65分まで）。"}
        </p>
        <label className="mt-1.5 flex items-start gap-1.5">
          <input
            type="checkbox"
            checked={push.deviceScope === "personal"}
            onChange={(e) => onDeviceScopeChange?.(e.target.checked ? "personal" : "shared")}
            className="mt-0.5"
          />
          <span>この端末は自分専用（自分のスマホ・PC）。閉じていても30日間届けます。共用のPCでは選ばないでください。</span>
        </label>
      </div>
    );
  }
  if (push.status === "working") return <p className="mt-2 text-gray-500 dark:text-gray-400">画面を閉じていても届くように設定しています…</p>;
  if (push.status === "reload_required") return <p className="mt-2">画面を再読み込みすると、画面を閉じていても届くようになります。</p>;
  if (push.status === "failed") return <p className="mt-2">画面を閉じているときの通知は、いま設定できませんでした（画面を開いている間は届きます）。</p>;
  return null;
}

export function NotificationPanel({
  items,
  permission,
  deviceLabel,
  onMarkAllRead,
  onItemClick,
  onRequestPermission,
  requesting = false,
  push = { status: "off" },
  onDeviceScopeChange,
}: {
  items: NotificationPanelItem[];
  permission: NotificationPermissionView;
  push?: PushView;
  onDeviceScopeChange?: (scope: "shared" | "personal") => void;
  /** 「この PC」「このスマホ」 */
  deviceLabel: string;
  onMarkAllRead: () => void;
  onItemClick: (item: NotificationPanelItem) => void;
  onRequestPermission: () => void;
  requesting?: boolean;
}) {
  return (
    <div
      role="dialog"
      aria-label="お知らせ"
      className="fixed inset-x-2 top-14 z-40 overflow-hidden rounded-lg border border-gray-200 bg-white shadow-xl sm:absolute sm:inset-x-auto sm:top-11 sm:right-0 sm:w-[360px] dark:border-gray-800 dark:bg-gray-900"
    >
      <div className="flex items-center justify-between border-b border-gray-200 px-3.5 py-3 dark:border-gray-800">
        <p className="text-sm font-bold text-gray-900 dark:text-gray-100">お知らせ</p>
        {items.some((i) => i.unread) && (
          <button
            type="button"
            onClick={onMarkAllRead}
            className="text-xs text-indigo-600 hover:underline dark:text-indigo-400"
          >
            すべて確認済みにする
          </button>
        )}
      </div>

      {items.length === 0 ? (
        <p className="px-3.5 py-7 text-center text-sm text-gray-500 dark:text-gray-400">新しいお知らせはありません</p>
      ) : (
        <ul className="max-h-[50vh] overflow-y-auto">
          {items.map((item) => {
            const Icon = ITEM_ICON[item.icon];
            return (
              <li key={item.id} className="border-b border-gray-200 last:border-b-0 dark:border-gray-800">
                <button
                  type="button"
                  onClick={() => onItemClick(item)}
                  className={`flex w-full gap-2.5 px-3.5 py-3 text-left text-sm leading-relaxed hover:bg-gray-50 dark:hover:bg-gray-800/60 ${
                    item.unread ? "bg-indigo-50/70 dark:bg-indigo-500/10" : ""
                  }`}
                >
                  <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full ${ITEM_TONE[item.tone]}`}>
                    <Icon className="h-4 w-4" aria-hidden="true" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-gray-900 dark:text-gray-100">{item.message}</span>
                    <span className="mt-0.5 block text-[11px] text-gray-500 dark:text-gray-400">{item.meta}</span>
                  </span>
                  {item.unread && (
                    <span className="mt-2 h-2 w-2 shrink-0 rounded-full bg-indigo-600 dark:bg-indigo-400" aria-label="未確認" />
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      )}

      <div className="border-t border-gray-200 bg-gray-50 px-3.5 py-3 text-xs leading-relaxed text-gray-700 dark:border-gray-800 dark:bg-gray-950 dark:text-gray-300">
        <p className="mb-1 flex items-center gap-1.5 text-sm font-bold text-gray-900 dark:text-gray-100">
          <Smartphone className="h-4 w-4" aria-hidden="true" />
          PC・スマホにも通知する
        </p>
        {permission === "default" && (
          <>
            <p>別の画面を見ているときも、{deviceLabel}の通知欄に知らせます。</p>
            <button
              type="button"
              onClick={onRequestPermission}
              disabled={requesting}
              className="mt-2 inline-flex items-center justify-center gap-1.5 rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-60"
            >
              通知を許可する
            </button>
          </>
        )}
        {permission === "granted" && (
          <p>
            <span className="inline-flex items-center gap-1 font-bold text-green-700 dark:text-green-400">
              <Check className="h-4 w-4" aria-hidden="true" />
              {deviceLabel}に通知します
            </span>
            <br />
            止めるときはブラウザの設定から変更してください。
          </p>
        )}
        {permission === "granted" && <PushStatusLine push={push} onDeviceScopeChange={onDeviceScopeChange} />}
        {permission === "denied" && (
          <p>
            <span className="inline-flex items-center gap-1 font-bold text-gray-900 dark:text-gray-100">
              <BellOff className="h-4 w-4" aria-hidden="true" />
              通知がブロックされています
            </span>
            <br />
            ブラウザのアドレス欄の左の鍵マークから「通知」を許可してください。画面内のお知らせはこれまでどおり出ます。
          </p>
        )}
        {permission === "unsupported" && (
          <p>
            このブラウザでは PC・スマホの通知を使えません。画面内のお知らせはこれまでどおり出ます。
            <br />
            <span className="text-gray-500 dark:text-gray-400">iPhone はホーム画面に追加すると使えます。</span>
          </p>
        )}
      </div>
    </div>
  );
}
