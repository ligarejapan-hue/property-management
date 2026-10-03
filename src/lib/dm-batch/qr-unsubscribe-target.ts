/**
 * 宛名CSVの1通の配信停止で、どの送付記録に拒否を付けるか(純関数・設計 2026-10-03 §5.1-4)。
 *  - use           : 控えの行に結んだ記録が残っている(確定済み、または確定前に一度停止済み)
 *  - create        : 確定前で記録が無い → この1通の記録を作る(手紙が手元にある=署名付きURLを持っている)
 *  - legacy_lookup : 確定済みなのに結び付きが無い(本機能より前の控え)→ 一意に引ければ使う
 * DB・認証に依存しないファイルに置く(テストが next/server を読まずに済むように)。
 */
export function decideBatchUnsubscribeTarget(s: {
  logId: string | null;
  logExists: boolean;
  confirmed: boolean;
}): "use" | "create" | "legacy_lookup" {
  if (s.logId && s.logExists) return "use";
  return s.confirmed ? "legacy_lookup" : "create";
}
