/**
 * 一括アップロードの中断・再開用の送信済み請求番号ストア(ブラウザ localStorage)。
 * 請求番号はグローバルに一意なため単一キー集合で運用する。
 * SSR/テスト(window無)では no-op。正しさの最終担保はサーバ側の請求番号 dedup。
 */
const STORAGE_KEY = "registry-pdf-bulk:sent-keys";

function safeStorage(): Storage | null {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}

export function loadSentKeys(): Set<string> {
  const s = safeStorage();
  if (!s) return new Set();
  try {
    const raw = s.getItem(STORAGE_KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    return Array.isArray(arr)
      ? new Set(arr.filter((x): x is string => typeof x === "string"))
      : new Set();
  } catch {
    return new Set();
  }
}

export function recordSentKeys(keys: string[]): void {
  const s = safeStorage();
  if (!s) return;
  const cur = loadSentKeys();
  for (const k of keys) cur.add(k);
  try {
    s.setItem(STORAGE_KEY, JSON.stringify([...cur]));
  } catch {
    // quota 超過等は無視(再開効率が落ちるだけで、サーバ dedup が二重添付を防ぐ)
  }
}

export function clearSentKeys(): void {
  const s = safeStorage();
  if (!s) return;
  try {
    s.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}
