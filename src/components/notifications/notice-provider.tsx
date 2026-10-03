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
  NOTICE_SWITCH_KEY,
  addNotice,
  readSwitchMark,
  loadNotices,
  markAllNoticesRead,
  readNoticeSnapshot,
  saveNotices,
  serverNoticeSnapshot,
  subscribeNotices,
  withNoticeLock,
  type Notice,
  type NoticeKind,
} from "@/lib/notifications/notice-store";
import {
  closeOsNotification,
  fetchSwGeneration,
  notificationSupport,
  extendPushDevice,
  registerNotificationWorker,
  requestNotificationPermission,
  setupPushDevice,
  showOsNotification,
  type DeviceScope,
  type NotificationSupport,
} from "@/lib/notifications/sw-client";

/**
 * 画面を閉じていても届く通知(段階4a)の状態。
 * on = この端末を登録済み / not_configured = サーバーの準備がまだ(VAPID 未設定) /
 * reload_required = 古い Service Worker が動いている(再読み込みが要る) / failed・unsupported = 使えない。
 */
export type PushState =
  | { status: "on"; deviceScope: DeviceScope }
  | { status: "off" | "not_configured" | "reload_required" | "failed" | "unsupported" | "working" };

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
  /** 押すと該当の画面へ(段階2の「開く」)。 */
  action?: ReactNode;
}

interface NoticeContextValue {
  notify: (input: NotifyInput) => void;
  toast: (input: ToastInput) => void;
  /** 取り下げた知らせ(同じ tag)の OS の通知を閉じる。ベルの記録は残す。 */
  withdraw: (tag: string) => void;
  notices: Notice[];
  markAllRead: () => void;
  permission: NotificationSupport;
  requestPermission: () => Promise<void>;
  push: PushState;
  /** 「この端末は自分専用」の切り替え(今の利用者が自分で選ぶ)。 */
  setDeviceScope: (scope: DeviceScope) => Promise<void>;
  /** 自動ログオフの延長(5分ごと)に合わせて、shared の端末の期限を延ばす。 */
  extendPush: () => void;
}

const noop = () => {};
const NoticeContext = createContext<NoticeContextValue>({
  notify: noop,
  toast: noop,
  withdraw: noop,
  notices: [],
  markAllRead: noop,
  permission: "unsupported",
  requestPermission: async () => {},
  push: { status: "off" },
  setDeviceScope: async () => {},
  extendPush: noop,
});

export function useNotices(): NoticeContextValue {
  return useContext(NoticeContext);
}

function toPushState(r: Awaited<ReturnType<typeof setupPushDevice>>): PushState {
  if (r.ok) return { status: "on", deviceScope: r.deviceScope };
  return { status: r.reason === "denied" ? "off" : r.reason };
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
  const [push, setPush] = useState<PushState>({ status: "off" });
  // 登録の結果は「最後に始めた操作」のものだけを画面に映す(自動の付け替えが、あとから押した
  // 「自分専用」の結果を上書きしないため)。
  const pushSeqRef = useRef(0);
  const switchedRef = useRef(false);
  /** このタブを開いた時点の後片付けの合図。書き込む直前に読み直して比べる。 */
  const switchMarkRef = useRef<string | null>(null);

  useEffect(() => {
    switchMarkRef.current = readSwitchMark();
    let cancelled = false;
    const onSwMessage = (e: MessageEvent) => {
      const data = e.data as { type?: string } | null;
      // 共用 PC で別の人がログインした=このタブは前の人のもの。以後このタブからは
      // ベル・OS の通知・右下のポップアップのどれも出さない(書き戻さない)。
      if (data?.type === "pm-switched") markSwitched();
    };
    const markSwitched = () => {
      switchedRef.current = true;
      setToasts([]);
    };
    // ほかのタブの後片付け(Service Worker の返事が無いときの直接の後片付けを含む)の合図。
    const onStorage = (e: StorageEvent) => {
      if (e.key === NOTICE_SWITCH_KEY) markSwitched();
    };
    window.addEventListener("storage", onStorage);
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.addEventListener("message", onSwMessage);
      void registerNotificationWorker().then(async () => {
        const gen = await fetchSwGeneration();
        if (!cancelled && gen !== null && genRef.current === null) genRef.current = gen;
        // 段階4a: 許可済みの端末は、ログインのたびに今の利用者へ付け替える(前の人の
        // 「自分専用」を引き継がない=範囲は渡さない・設計書 §7.5 の 2)。
        if (!cancelled && genRef.current !== null && notificationSupport() === "granted" && !switchedRef.current) {
          const seq = ++pushSeqRef.current;
          const r = await setupPushDevice({
            gen: genRef.current,
            subscribeIfMissing: true,
            isCancelled: () => cancelled || switchedRef.current || readSwitchMark() !== switchMarkRef.current,
          });
          if (!cancelled && seq === pushSeqRef.current) setPush(toPushState(r));
        }
      });
    }
    return () => {
      cancelled = true;
      window.removeEventListener("storage", onStorage);
      if ("serviceWorker" in navigator) navigator.serviceWorker.removeEventListener("message", onSwMessage);
    };
  }, []);

  const toast = useCallback((input: ToastInput) => {
    if (switchedRef.current) return;
    setToasts((prev) => [...prev.slice(-3), { id: newId(), ...input }]);
  }, []);

  const notify = useCallback((input: NotifyInput) => {
    // 後片付けを知らされたタブ(前の人のまま開いていた)からは何も書かない・出さない。
    if (switchedRef.current) return;
    const now = Date.now();
    // ⚠書き込む直前に後片付けの合図をその場で読み直す。storage イベントはあとから届くため、
    //   ほかのタブの後片付けと重なったときに前の人のお知らせを書き戻さないよう、ここでも止める
    //   (@codex #462 P1)。
    if (readSwitchMark() !== switchMarkRef.current) {
      switchedRef.current = true;
      setToasts([]);
      return;
    }
    if (input.bell !== false) {
      const notice: Notice = {
        id: newId(),
        kind: input.kind,
        tag: input.tag,
        message: input.body,
        context: input.context,
        url: input.url,
        at: now,
        read: false,
        // 書いたときの合図を付ける。読む側は今の合図と違うものを出さないため、この確認と
        // 書き込みの間にほかのタブが後片付けをしても、前の人のお知らせは見えない(@codex #462 P1)。
        ...(switchMarkRef.current !== null ? { mark: switchMarkRef.current } : {}),
      };
      // ほかのタブと順番に読み→足す→書く(同時に足したとき片方が消えない・@codex #462)。
      // 順番を待つ間に後片付けがあれば書かない。
      withNoticeLock(() => {
        if (switchedRef.current || readSwitchMark() !== switchMarkRef.current) return;
        saveNotices(addNotice(loadNotices(Date.now()), notice, Date.now()));
      });
    }
    if (input.osWhenHidden && document.visibilityState === "hidden") {
      const gen = genRef.current;
      if (gen !== null) {
        void showOsNotification({ gen, title: input.title, body: input.body, tag: input.tag, url: input.url });
      }
    }
  }, []);

  const withdraw = useCallback((tag: string) => {
    // 後片付けを知らされたタブ(前の人のまま)からは閉じない。同じ tag の次の人の通知を
    // 閉じないよう、世代も渡して Service Worker 側でも確かめる(@codex #462)。
    if (switchedRef.current || readSwitchMark() !== switchMarkRef.current) return;
    const gen = genRef.current;
    if (gen === null) return;
    void closeOsNotification(tag, gen);
  }, []);

  const markAllRead = useCallback(() => {
    // 後片付けを知らされたタブ(前の人のまま)からは、次の人のお知らせを書き換えない。
    withNoticeLock(() => {
      if (switchedRef.current || readSwitchMark() !== switchMarkRef.current) return;
      saveNotices(markAllNoticesRead(loadNotices(Date.now())));
    });
  }, []);

  // ⚠後片付け(ログアウト・ログイン画面)が起きていたら登録し直さない(解除のあとに配信を再開させない)。
  //   ref を読む関数は、ref を書き換える処理(上の useEffect・notify)より後ろで作る(react-hooks/immutability)。
  const isCancelled = useCallback(() => switchedRef.current || readSwitchMark() !== switchMarkRef.current, []);
  const runPushSetup = useCallback(
    async (opts: { gen: number; deviceScope?: DeviceScope }) => {
      const seq = ++pushSeqRef.current;
      const r = await setupPushDevice({ ...opts, subscribeIfMissing: true, isCancelled });
      if (seq === pushSeqRef.current) setPush(toPushState(r));
    },
    [isCancelled],
  );

  const requestPermission = useCallback(async () => {
    const result = await requestNotificationPermission();
    setPermission(result);
    if (result === "granted") {
      const gen = await fetchSwGeneration();
      if (gen !== null) genRef.current = gen;
      toast({ tone: "green", icon: "check", title: "通知を許可しました", body: "別の画面を見ているときも、この端末に知らせます" });
      if (gen !== null && !switchedRef.current) {
        setPush({ status: "working" });
        await runPushSetup({ gen });
      }
    }
  }, [toast, runPushSetup]);

  const setDeviceScope = useCallback(async (scope: DeviceScope) => {
    const gen = genRef.current;
    if (gen === null || switchedRef.current) return;
    setPush({ status: "working" });
    await runPushSetup({ gen, deviceScope: scope });
  }, [runPushSetup]);

  const extendPush = useCallback(() => {
    const gen = genRef.current;
    if (gen === null || switchedRef.current) return;
    void extendPushDevice(gen, isCancelled);
  }, [isCancelled]);

  const dismissToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const value = useMemo(
    () => ({ notify, toast, withdraw, notices, markAllRead, permission, requestPermission, push, setDeviceScope, extendPush }),
    [notify, toast, withdraw, notices, markAllRead, permission, requestPermission, push, setDeviceScope, extendPush],
  );

  return (
    <NoticeContext.Provider value={value}>
      {children}
      <ToastStack toasts={toasts} onDismiss={dismissToast} />
    </NoticeContext.Provider>
  );
}
