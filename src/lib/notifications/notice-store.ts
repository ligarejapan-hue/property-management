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

export type NoticeKind =
  | "edit_lock_warn"
  | "edit_lock_lost"
  | "idle_logout_warn"
  // 段階2(画面を開いている間に件数を取りに行って知らせる・設計書 §5)
  | "next_action"
  | "inquiry_new"
  | "registry_job_done";

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
  /**
   * 書いたときの後片付けの合図(`NOTICE_SWITCH_KEY` の値。無ければ付けない)。
   * 読むときに今の合図と違うものは出さない。後片付けと重なって前の人のタブが書き戻しても、
   * 次の人には見えない(@codex #462 P1)。
   */
  mark?: string;
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

const KINDS: readonly NoticeKind[] = ["edit_lock_warn", "edit_lock_lost", "idle_logout_warn", "next_action", "inquiry_new", "registry_job_done"];

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
    (n.mark === undefined || typeof n.mark === "string") &&
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

/** 今の後片付けの合図(`mark`)で書かれたものだけを残す。 */
export function noticesForMark(list: Notice[], mark: string | null): Notice[] {
  const kept = list.filter((n) => (n.mark ?? null) === mark);
  return kept.length === list.length ? list : kept;
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
  const mark = readSwitchMark();
  if (memoryFallback) return noticesForMark(memoryFallback, mark);
  try {
    return noticesForMark(parseNotices(window.localStorage.getItem(NOTICE_STORAGE_KEY), now), mark);
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
let cachedMark: string | null = null;
let cachedSource: Notice[] | null = null;
let cachedList: Notice[] = EMPTY;

export function readNoticeSnapshot(): Notice[] {
  const mark = readSwitchMark();
  let source: Notice[] | null = memoryFallback;
  let raw: string | null = null;
  if (!source) {
    try {
      raw = window.localStorage.getItem(NOTICE_STORAGE_KEY);
    } catch {
      return EMPTY;
    }
  }
  if (source !== cachedSource || raw !== cachedRaw || mark !== cachedMark) {
    cachedSource = source;
    cachedRaw = raw;
    cachedMark = mark;
    if (!source) source = raw ? parseNotices(raw, Date.now()) : EMPTY;
    const kept = noticesForMark(source, mark);
    cachedList = kept.length ? kept : EMPTY;
  }
  return cachedList;
}

export function serverNoticeSnapshot(): Notice[] {
  return EMPTY;
}

export function subscribeNotices(onChange: () => void): () => void {
  const onStorage = (e: StorageEvent) => {
    if (e.key === null || e.key === NOTICE_STORAGE_KEY || e.key === NOTICE_SWITCH_KEY) onChange();
  };
  window.addEventListener(NOTICE_CHANGED_EVENT, onChange);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(NOTICE_CHANGED_EVENT, onChange);
    window.removeEventListener("storage", onStorage);
  };
}

/**
 * ベルの読み→足す→書くを、同じブラウザのほかのタブと1件ずつ順に行う(Web Locks)。
 * 2つのタブがほぼ同時に知らせを足したとき、あとから書いた方が先の追加を上書きして
 * 消さないため(@codex #462)。Web Locks が無い環境ではその場で行う。
 */
export const NOTICE_LOCK_NAME = "pm:notices";

export function withNoticeLock(fn: () => void): void {
  const locks = typeof navigator !== "undefined" ? (navigator as Navigator & { locks?: LockManager }).locks : undefined;
  if (!locks || typeof locks.request !== "function") {
    fn();
    return;
  }
  try {
    void locks.request(NOTICE_LOCK_NAME, async () => fn()).catch(() => {});
  } catch {
    fn();
  }
}

/** 後片付けの合図(最後に片付けた時刻の文字列)。読めなければ null。 */
export function readSwitchMark(): string | null {
  try {
    return window.localStorage.getItem(NOTICE_SWITCH_KEY);
  } catch {
    return null;
  }
}

/**
 * 段階2の「どこまで読んだか・見たか」(カーソルと見た印)の保存先の頭(利用者 ID ごと)。
 * 中身は不透明な値だけ(生の ID・期限を置かない・設計書 §5.2)。後片付けでどの利用者の分も消す。
 */
export const SUMMARY_STATE_PREFIX = "pm:notif-summary:";

/**
 * 保存できない環境(private mode・容量超過)での、この画面の間だけの控え。控えが無いと、見た印も
 * カーソルも残らず、次回対応が毎分出直し、申込・謄本は毎回「初回」になって知らせが出ない
 * (提出前レビュー)。後片付けで消す。
 */
let summaryFallback: Map<string, string> | null = null;

export function readSummaryRaw(key: string): string | null {
  if (summaryFallback?.has(key)) return summaryFallback.get(key) ?? null;
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writeSummaryRaw(key: string, raw: string): void {
  try {
    window.localStorage.setItem(key, raw);
    summaryFallback?.delete(key);
  } catch {
    (summaryFallback ??= new Map()).set(key, raw);
  }
}

/** 共用 PC 対策: ログアウト・ログイン画面で呼ぶ。 */
export function clearNoticeStorage(): void {
  memoryFallback = null;
  summaryFallback = null;
  try {
    const ls = window.localStorage;
    const summaryKeys: string[] = [];
    for (let i = 0; i < ls.length; i++) {
      const k = ls.key(i);
      if (k && k.startsWith(SUMMARY_STATE_PREFIX)) summaryKeys.push(k);
    }
    for (const k of summaryKeys) ls.removeItem(k);
  } catch {
    /* noop */
  }
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
