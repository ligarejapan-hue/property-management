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

function notify(): void {
  for (const fn of [...listeners]) fn();
}

/** 控えが書かれた・消えたときに呼ばれる(小窓の自動再オープン用)。戻り値で解除。 */
export function subscribeDrafts(listener: () => void): () => void {
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

/** 控えがあるか(封筒と期限だけ見る・消さない)。 */
export function hasDraft(key: string, now: number = Date.now()): boolean {
  return parseEnvelope(getRaw(key), now) != null;
}

export function writeDraft<T>(key: string, draft: StoredDraft<T>): WriteResult {
  const s = store();
  if (!s) return "failed";
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
    return "failed";
  }
  notify();
  return "ok";
}

export function clearDraft(key: string): void {
  removeRaw(key);
  notify();
}

/** pm-draft: で始まる鍵をすべて消す(ログアウト・ログイン成功時)。 */
export function clearAllDrafts(): void {
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
