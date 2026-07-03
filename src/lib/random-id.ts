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
