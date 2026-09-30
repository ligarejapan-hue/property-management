/**
 * ベル(お知らせ)の中身を、その端末のブラウザ(localStorage)にだけ持つ(通知 段階1・設計書 §4.4)。
 *
 * - 段階1では DB を変えないため、別の端末には出ない。7日を過ぎたものから捨てる。
 * - ⚠中身は種類と定型文・時刻・画面のパスだけ。物件名・所有者名・住所などは入れない
 *   (CLAUDE.md §8)。パスに含まれる ID は UUID のみ。
 * - 共用 PC で前の人のお知らせが次の人に見えないよう、ログアウト・ログイン画面で
 *   `clearNoticeStorage()` を呼ぶ(`sw-client.ts` の `cleanupNotifications` の相方)。
 *
 * 判断(追加・重複の置き換え・期限切れの除去・既読化)は純関数にして node で試せるようにする。
 */

export type NoticeKind = "edit_lock_warn" | "edit_lock_lost" | "idle_logout_warn";

export interface Notice {
  id: string;
  kind: NoticeKind;
  /** 同じ知らせを重ねないための印(例 `edit-lock:warn:property:<uuid>`)。 */
  tag: string;
  /** ベルに出す本文(定型文)。 */
  message: string;
  /** 補足(例「物件の編集」)。PII を入れない。 */
  context?: string;
  /** 押したときに開く画面(同じオリジンのパスだけ)。 */
  url?: string;
  at: number;
  read: boolean;
}

export const NOTICE_STORAGE_KEY = "pm:notices:v1";
export const NOTICE_CHANGED_EVENT = "pm:notices-changed";
/**
 * 後片付け(ログアウト・ログイン画面)の合図。ほかのタブは storage イベントでこれを受け、
 * 以後そのタブからはお知らせを書かない・出さない(前の人のまま開いていたタブが、片付けた後に
 * 前の人のお知らせを書き戻さないため・@codex #462)。中身は時刻だけ。
 */
export const NOTICE_SWITCH_KEY = "pm:notices:switched-at";
export const NOTICE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const NOTICE_MAX = 50;

const KINDS: readonly NoticeKind[] = ["edit_lock_warn", "edit_lock_lost", "idle_logout_warn"];

function isNotice(v: unknown): v is Notice {
  if (!v || typeof v !== "object") return false;
  const n = v as Record<string, unknown>;
  return (
    typeof n.id === "string" &&
    typeof n.tag === "string" &&
    typeof n.message === "string" &&
    typeof n.at === "number" &&
    typeof n.read === "boolean" &&
    KINDS.includes(n.kind as NoticeKind) &&
    (n.context === undefined || typeof n.context === "string") &&
    (n.url === undefined || (typeof n.url === "string" && n.url.startsWith("/") && !n.url.startsWith("//")))
  );
}

/** 保存値を読み、壊れた行・期限切れを捨てて新しい順に並べる。 */
export function parseNotices(raw: string | null, now: number): Notice[] {
  if (!raw) return [];
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(data)) return [];
  return data
    .filter(isNotice)
    .filter((n) => now - n.at < NOTICE_TTL_MS)
    .sort((a, b) => b.at - a.at)
    .slice(0, NOTICE_MAX);
}

/** 同じ tag の古いものを置き換えて先頭に足す。 */
export function addNotice(list: Notice[], notice: Notice, now: number): Notice[] {
  return [notice, ...list.filter((n) => n.tag !== notice.tag)]
    .filter((n) => now - n.at < NOTICE_TTL_MS)
    .slice(0, NOTICE_MAX);
}

export function markAllNoticesRead(list: Notice[]): Notice[] {
  return list.map((n) => (n.read ? n : { ...n, read: true }));
}

export function unreadNoticeCount(list: Notice[]): number {
  return list.filter((n) => !n.read).length;
}

// ---- ブラウザの保存領域(失敗しても画面は動かす) ----

/**
 * 保存できなかったとき(容量超過・保存の制限)の、この画面の間だけの控え。
 * 保存できない環境でもベルには出す(@codex #462)。後片付けで消す。
 */
let memoryFallback: Notice[] | null = null;

export function loadNotices(now: number): Notice[] {
  if (memoryFallback) return memoryFallback;
  try {
    return parseNotices(window.localStorage.getItem(NOTICE_STORAGE_KEY), now);
  } catch {
    return [];
  }
}

export function saveNotices(list: Notice[]): void {
  try {
    window.localStorage.setItem(NOTICE_STORAGE_KEY, JSON.stringify(list));
    memoryFallback = null;
  } catch {
    // private mode 等では保存しない(この画面の間だけ控えを持ってベルに出す)。
    memoryFallback = list;
  }
  try {
    window.dispatchEvent(new Event(NOTICE_CHANGED_EVENT));
  } catch {
    /* noop */
  }
}

// ---- React から読む(useSyncExternalStore 用。保存値が変わらない限り同じ配列を返す) ----

const EMPTY: Notice[] = [];
let cachedRaw: string | null = null;
let cachedList: Notice[] = EMPTY;

export function readNoticeSnapshot(): Notice[] {
  if (memoryFallback) return memoryFallback;
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(NOTICE_STORAGE_KEY);
  } catch {
    return EMPTY;
  }
  if (raw !== cachedRaw) {
    cachedRaw = raw;
    cachedList = raw ? parseNotices(raw, Date.now()) : EMPTY;
  }
  return cachedList;
}

export function serverNoticeSnapshot(): Notice[] {
  return EMPTY;
}

export function subscribeNotices(onChange: () => void): () => void {
  const onStorage = (e: StorageEvent) => {
    if (e.key === null || e.key === NOTICE_STORAGE_KEY) onChange();
  };
  window.addEventListener(NOTICE_CHANGED_EVENT, onChange);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(NOTICE_CHANGED_EVENT, onChange);
    window.removeEventListener("storage", onStorage);
  };
}

/** 後片付けの合図(最後に片付けた時刻の文字列)。読めなければ null。 */
export function readSwitchMark(): string | null {
  try {
    return window.localStorage.getItem(NOTICE_SWITCH_KEY);
  } catch {
    return null;
  }
}

/** 共用 PC 対策: ログアウト・ログイン画面で呼ぶ。 */
export function clearNoticeStorage(): void {
  memoryFallback = null;
  try {
    window.localStorage.removeItem(NOTICE_STORAGE_KEY);
    window.localStorage.setItem(NOTICE_SWITCH_KEY, String(Date.now()));
  } catch {
    /* noop */
  }
  try {
    window.dispatchEvent(new Event(NOTICE_CHANGED_EVENT));
  } catch {
    /* noop */
  }
}
