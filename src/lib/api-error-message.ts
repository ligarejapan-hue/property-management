/**
 * API のエラー応答(JSON)から、人に見せる文を取り出す。
 *
 * サーバーの `handleApiError` は `{ error: { message, code } }` の形で返す。古い画面には
 * `{ error: "文" }` を前提に `alert(json.error ?? "…")` と書いたものがあり、オブジェクトが
 * そのまま文字列化されて「[object Object]」と出ていた(実機確認 2026-10-23・権限テンプレート)。
 * どちらの形でも文だけを返し、取れなければ画面が用意した既定の文に落とす。
 */
export function apiErrorMessage(body: unknown, fallback: string): string {
  if (body && typeof body === "object") {
    const err = (body as { error?: unknown }).error;
    if (typeof err === "string" && err.trim()) return err;
    if (err && typeof err === "object") {
      const msg = (err as { message?: unknown }).message;
      if (typeof msg === "string" && msg.trim()) return msg;
    }
  }
  return fallback;
}
