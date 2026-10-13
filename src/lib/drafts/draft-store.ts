/**
 * 作業中の入力の控え(設計書 docs/superpowers/specs/2026-10-13-keep-draft-on-navigate-design.md §4.1)。
 *
 * - 置き場は sessionStorage だけ(タブを閉じると消える)。localStorage・IndexedDB は使わない。
 * - 鍵に利用者IDは入れない。ログアウト・ログイン成功のたびに全消しするので、タブの控えは
 *   常に今ログインしている人のもの(§4.2)。
 * - 読み書きはすべて try/catch。使えない端末では何もしない(これまでどおり消えるだけ)。
 * - ⚠控えの中身をログ・エラー表示に出さない(所有者の名前・住所が入りうる)。
 */

export const DRAFT_PREFIX = "pm-draft:v1:";
export const DRAFT_MAX_AGE_MS = 12 * 60 * 60 * 1000;
export const DRAFT_MAX_CHARS = 1_500_000;
/** 期限切れの控えを掃除する間隔(何も操作しないタブでも 12時間+1分以内に消す)。 */
export const DRAFT_SWEEP_INTERVAL_MS = 60 * 1000;

export const DRAFT_SCREENS = [
  "new-property:properties",
  "new-property:sales-sheet",
  "property-edit",
  "paste",
  "paste-excel",
  "registry-pdf",
  "csv-import",
] as const;
export type DraftScreen = (typeof DRAFT_SCREENS)[number];

export interface StoredDraft<T> {
  v: 1;
  savedAt: number;
  data: T;
  /** 登録・取り込みを送った時刻。返事を受け取る前に画面を離れると残る(§5.1)。 */
  pendingSubmit?: { at: number };
}

export type WriteResult = "ok" | "too_large" | "failed";

export function draftKey(screen: DraftScreen, resourceId?: string): string {
  return DRAFT_PREFIX + screen + (resourceId ? `:${resourceId}` : "");
}

const listeners = new Set<() => void>();

/**
 * ログアウトで全消しした後は、このページが読み込み直されるまで書かない。
 * ⚠ログアウトの移動で小窓が閉じる瞬間(unmount・pagehide)の即時書き込みが、消したばかりの
 *   控えを書き戻すのを防ぐ(共用PC対策)。signOut は読み込み直しを伴うので、次の画面では外れている。
 */
let lockedUntilReload = false;

/** ログアウトに失敗して画面に残ったとき、鍵を外してまた控えられるようにする(@codex P2)。 */
export function unlockDrafts(): void {
  lockedUntilReload = false;
}

function notify(): void {
  for (const fn of [...listeners]) fn();
}

/** 控えが書かれた・消えたときに呼ばれる(小窓の自動再オープン用)。戻り値で解除。 */
export function subscribeDrafts(listener: () => void): () => void {
  // 見張りを始める画面(物件一覧など)を開くたびに、期限切れの控えを掃除する。
  purgeExpiredDrafts();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function store(): Storage | null {
  try {
    const s = (globalThis as { sessionStorage?: Storage }).sessionStorage;
    return s ?? null;
  } catch {
    return null;
  }
}

function getRaw(key: string): string | null {
  try {
    return store()?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function removeRaw(key: string): void {
  try {
    store()?.removeItem(key);
  } catch {
    /* 使えない端末では何もしない */
  }
}

/** 封筒の形と期限だけを見る(中身の検査は呼び出し側の parseData)。 */
function parseEnvelope(raw: string | null, now: number): StoredDraft<unknown> | null {
  if (raw == null) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== "object") return null;
  const o = obj as Record<string, unknown>;
  if (o.v !== 1 || typeof o.savedAt !== "number" || !Number.isFinite(o.savedAt)) return null;
  if (!("data" in o)) return null;
  if (now - o.savedAt > DRAFT_MAX_AGE_MS) return null;
  let pendingSubmit: { at: number } | undefined;
  if (o.pendingSubmit !== undefined) {
    const p = o.pendingSubmit as { at?: unknown } | null;
    if (!p || typeof p.at !== "number") return null;
    pendingSubmit = { at: p.at };
  }
  return { v: 1, savedAt: o.savedAt, data: o.data, ...(pendingSubmit ? { pendingSubmit } : {}) };
}

/** 控えを読む。壊れ・形違い・期限切れは消して null。 */
export function readDraft<T>(
  key: string,
  parseData: (data: unknown) => T | null,
  now: number = Date.now(),
): StoredDraft<T> | null {
  const raw = getRaw(key);
  if (raw == null) return null;
  const env = parseEnvelope(raw, now);
  const data = env ? parseData(env.data) : null;
  if (!env || data == null) {
    removeRaw(key);
    return null;
  }
  return { ...env, data };
}

/**
 * 控えがあるか(封筒と期限だけ見る)。期限切れ・壊れた控えはここで消す(12時間を過ぎて
 * 残さない・@codex P2)。⚠知らせない=useSyncExternalStore の描画中に呼ばれるため
 * (消した結果も false で、見えている状態と食い違わない)。
 */
export function hasDraft(key: string, now: number = Date.now()): boolean {
  const raw = getRaw(key);
  if (raw == null) return false;
  if (parseEnvelope(raw, now) != null) return true;
  removeRaw(key);
  return false;
}

export function writeDraft<T>(key: string, draft: StoredDraft<T>): WriteResult {
  if (lockedUntilReload) return "failed";
  const s = store();
  if (!s) return "failed";
  // 書くたびに期限切れの控えを掃除する(12時間を過ぎて残さない・容量も空ける)。
  purgeExpiredDrafts();
  let text: string;
  try {
    text = JSON.stringify(draft);
  } catch {
    return "failed";
  }
  if (text.length > DRAFT_MAX_CHARS) return "too_large";
  try {
    s.setItem(key, text);
  } catch {
    // ⚠書き換えに失敗したら(容量いっぱいなど)前の控えを消す。残すと、古い入力が
    //   最新の続きのように戻ってしまう(@codex P2)。
    removeRaw(key);
    notify();
    return "failed";
  }
  notify();
  return "ok";
}

export function clearDraft(key: string): void {
  removeRaw(key);
  notify();
}

/**
 * 期限切れ・壊れた控えをすべて消す(開かれないままの物件の控えも 12時間で消すため)。
 * ⚠知らせない(消えるのは「無い」と扱われていた控えだけ=見えている状態は変わらない)。
 */
export function purgeExpiredDrafts(now: number = Date.now()): void {
  const s = store();
  if (!s) return;
  try {
    const stale: string[] = [];
    for (let i = 0; i < s.length; i++) {
      const k = s.key(i);
      if (k && k.startsWith(DRAFT_PREFIX) && parseEnvelope(s.getItem(k), now) == null) stale.push(k);
    }
    for (const k of stale) s.removeItem(k);
  } catch {
    /* 使えない端末では何もしない */
  }
}

/**
 * pm-draft: で始まる鍵をすべて消す(ログアウト・ログイン画面・ログイン成功時)。
 * lockUntilReload=ログアウト用。消した後、読み込み直すまで書かない。
 */
export function clearAllDrafts(opts: { lockUntilReload?: boolean } = {}): void {
  if (opts.lockUntilReload) lockedUntilReload = true;
  const s = store();
  if (s) {
    try {
      const keys: string[] = [];
      for (let i = 0; i < s.length; i++) {
        const k = s.key(i);
        if (k && k.startsWith(DRAFT_PREFIX)) keys.push(k);
      }
      for (const k of keys) s.removeItem(k);
    } catch {
      /* 使えない端末では何もしない */
    }
  }
  notify();
}

let sweeper: ReturnType<typeof setInterval> | null = null;

/**
 * 期限切れの控えを1分ごとに掃除する(何も操作しないタブでも 12時間で消すため・@codex P2)。
 * 何度呼んでも1つだけ。画面(ブラウザ)でこのモジュールが読み込まれた時点で始める
 * (ログアウト処理がダッシュボードの枠から読み込むので、ログイン中はどの画面でも動く)。
 */
export function startDraftExpirySweeper(): void {
  if (sweeper) return;
  purgeExpiredDrafts();
  sweeper = setInterval(() => purgeExpiredDrafts(), DRAFT_SWEEP_INTERVAL_MS);
}

if (typeof window !== "undefined") startDraftExpirySweeper();
