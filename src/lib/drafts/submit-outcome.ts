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

/**
 * 素の fetch を使う画面で、断られた応答を status つきの Error にする
 * (isDefiniteSubmitFailure が 4xx を見分けられるように)。
 */
export function httpError(message: string, status: number): Error & { status: number } {
  return Object.assign(new Error(message), { status });
}

/**
 * 取り込みの成功の返事が、結果として読める形か(@codex P2)。
 * 2xx でも中身が欠けていれば(配置の途中・壊れた返事)、取り込まれたか分からない扱いにする
 * =控えと送信中の印を消さずに止め、戻ったとき確かめてもらう。
 */
export function hasImportResultShape(
  value: unknown,
  shape: { numbers?: readonly string[]; arrays?: readonly string[]; objects?: readonly string[] },
): boolean {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v.jobId !== "string" || v.jobId === "") return false;
  if (shape.numbers?.some((k) => typeof v[k] !== "number")) return false;
  if (shape.arrays?.some((k) => !Array.isArray(v[k]))) return false;
  if (shape.objects?.some((k) => typeof v[k] !== "object" || v[k] === null || Array.isArray(v[k]))) return false;
  return true;
}
