"use client";

/**
 * 通知の土台(通知 段階1・設計書 §4)。ログイン後の画面全体を包む。
 *
 * - `notify()` 1つで「ベルに残す」「別の画面を見ているとき OS の通知を出す」「右下のポップアップ」
 *   を出し分ける。何を出すかの判断は呼び出し側(編集ロック・自動ログオフ)。
 * - Service Worker を登録し、「切り替えの世代」を受け取っておく。世代が変わった
 *   (共用 PC で別の人がログインした)と知らされたタブは、以後 OS の通知を出さない。
 * - Provider の外(テストの静的描画など)では何もしない既定値を返す。
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { ToastStack, type ToastIcon, type ToastItem, type ToastTone } from "@/components/ui/toast-stack";
import {
  addNotice,
  loadNotices,
  markAllNoticesRead,
  readNoticeSnapshot,
  saveNotices,
  serverNoticeSnapshot,
  subscribeNotices,
  type Notice,
  type NoticeKind,
} from "@/lib/notifications/notice-store";
import {
  fetchSwGeneration,
  notificationSupport,
  registerNotificationWorker,
  requestNotificationPermission,
  showOsNotification,
  type NotificationSupport,
} from "@/lib/notifications/sw-client";

export interface NotifyInput {
  kind: NoticeKind;
  /** 同じ知らせを重ねないための印(UUID 以外の ID・PII を入れない)。 */
  tag: string;
  title: string;
  body: string;
  context?: string;
  url?: string;
  /** ベルに残す(既定 true)。 */
  bell?: boolean;
  /** タブが見えていないときだけ OS の通知を出す(既定 false)。 */
  osWhenHidden?: boolean;
}

export interface ToastInput {
  tone: ToastTone;
  icon: ToastIcon;
  title: string;
  body?: string;
}

interface NoticeContextValue {
  notify: (input: NotifyInput) => void;
  toast: (input: ToastInput) => void;
  notices: Notice[];
  markAllRead: () => void;
  permission: NotificationSupport;
  requestPermission: () => Promise<void>;
}

const noop = () => {};
const NoticeContext = createContext<NoticeContextValue>({
  notify: noop,
  toast: noop,
  notices: [],
  markAllRead: noop,
  permission: "unsupported",
  requestPermission: async () => {},
});

export function useNotices(): NoticeContextValue {
  return useContext(NoticeContext);
}

function newId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function NoticeProvider({ children }: { children: ReactNode }) {
  // ベルの中身はその端末の保存領域が正(他のタブの追加もそのまま映る)。
  const notices = useSyncExternalStore(subscribeNotices, readNoticeSnapshot, serverNoticeSnapshot);
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  // 許可の状態はパネルを開いたときにしか描かない(サーバーとの描画差は出ない)。
  const [permission, setPermission] = useState<NotificationSupport>(() =>
    typeof window === "undefined" ? "unsupported" : notificationSupport(),
  );
  const genRef = useRef<number | null>(null);
  const switchedRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    const onSwMessage = (e: MessageEvent) => {
      const data = e.data as { type?: string } | null;
      // 共用 PC で別の人がログインした=このタブは前の人のもの。以後 OS の通知を出さない。
      if (data?.type === "pm-switched") switchedRef.current = true;
    };
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.addEventListener("message", onSwMessage);
      void registerNotificationWorker().then(async () => {
        const gen = await fetchSwGeneration();
        if (!cancelled && gen !== null && genRef.current === null) genRef.current = gen;
      });
    }
    return () => {
      cancelled = true;
      if ("serviceWorker" in navigator) navigator.serviceWorker.removeEventListener("message", onSwMessage);
    };
  }, []);

  const toast = useCallback((input: ToastInput) => {
    setToasts((prev) => [...prev.slice(-3), { id: newId(), ...input }]);
  }, []);

  const notify = useCallback((input: NotifyInput) => {
    const now = Date.now();
    if (input.bell !== false) {
      const next = addNotice(
        loadNotices(now),
        {
          id: newId(),
          kind: input.kind,
          tag: input.tag,
          message: input.body,
          context: input.context,
          url: input.url,
          at: now,
          read: false,
        },
        now,
      );
      saveNotices(next);
    }
    if (input.osWhenHidden && document.visibilityState === "hidden" && !switchedRef.current) {
      const gen = genRef.current;
      if (gen !== null) {
        void showOsNotification({ gen, title: input.title, body: input.body, tag: input.tag, url: input.url });
      }
    }
  }, []);

  const markAllRead = useCallback(() => {
    saveNotices(markAllNoticesRead(loadNotices(Date.now())));
  }, []);

  const requestPermission = useCallback(async () => {
    const result = await requestNotificationPermission();
    setPermission(result);
    if (result === "granted") {
      const gen = await fetchSwGeneration();
      if (gen !== null) genRef.current = gen;
      toast({ tone: "green", icon: "check", title: "通知を許可しました", body: "別の画面を見ているときも、この端末に知らせます" });
    }
  }, [toast]);

  const dismissToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const value = useMemo(
    () => ({ notify, toast, notices, markAllRead, permission, requestPermission }),
    [notify, toast, notices, markAllRead, permission, requestPermission],
  );

  return (
    <NoticeContext.Provider value={value}>
      {children}
      <ToastStack toasts={toasts} onDismiss={dismissToast} />
    </NoticeContext.Provider>
  );
}
