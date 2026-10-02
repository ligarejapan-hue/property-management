/**
 * フォールバック付きの一意 ID 生成。
 *
 * `crypto.randomUUID()` は secure context（HTTPS / localhost）でのみ利用可能で、
 * 非セキュアな HTTP オリジンでは `crypto.randomUUID` が未定義になり、呼ぶと throw する。
 * 本番が HTTP 配信の場合にクライアント側 ID 生成が壊れるのを防ぐため、未対応環境では
 * 時刻＋乱数の簡易 ID にフォールバックする（実用上、衝突は無視できる）。
 */
export function safeRandomId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/**
 * UUID v4 の形の乱数 ID。サーバーが UUID の形だけを受ける値(押し直しの鍵など)に使う。
 * `crypto.randomUUID` は secure context でしか使えないが、`crypto.getRandomValues` は平文 HTTP でも
 * 使える。どちらも無い環境では Math.random で同じ形に組む(衝突は実用上無視できる)。
 */
export function safeUuidV4(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  const b = new Uint8Array(16);
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    crypto.getRandomValues(b);
  } else {
    for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
  }
  b[6] = (b[6] & 0x0f) | 0x40; // 版=4
  b[8] = (b[8] & 0x3f) | 0x80; // 変種=10xx
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
