/**
 * エラーを**記録・表示してよい形**に丸める(許可リスト方式)。
 *
 * ⚠生の `err.message` は残さない。データベースや保管庫の例外は、拒否した呼び出しの
 *   中身(登記由来の住所・氏名など)を文面に埋め込むことがある。
 *   出してよいのは「種類(クラス名)」と「コード(英数字のみ)」だけ。
 *   → [[redaction-allowlist-not-pattern]] 伏せ字ではなく、安全なものだけで組み立てる。
 */
export function safeErrorSummary(err: unknown): string {
  const kind = err instanceof Error ? err.name : typeof err;
  const rawCode = (err as { code?: unknown } | null)?.code;
  const code =
    typeof rawCode === "string" && /^[A-Za-z0-9_]{1,32}$/.test(rawCode) ? rawCode : "-";
  return `種類=${kind} コード=${code}`;
}
