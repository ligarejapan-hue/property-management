/**
 * 登録の失敗が「登録されていない」と言い切れるか(設計書 §5.1・@codex P1)。
 * 言い切れるのはサーバーが 4xx で断ったときだけ。通信切れ・応答が読めない・5xx は、
 * サーバー側で保存が済んだ後に落ちたかもしれない=送信中の印を残して確かめてもらう。
 */
export function isDefiniteSubmitFailure(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const status = (err as Error & { status?: unknown }).status;
  return typeof status === "number" && status >= 400 && status < 500;
}
