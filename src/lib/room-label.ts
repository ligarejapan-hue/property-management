/**
 * 部屋番号の表示(「101」→「101号室」)。
 * 入力に「号室」「号」が既に入っていれば付け足さない(「101号室号室」にしない・2026-10-30)。空なら null。
 */
export function roomLabel(roomNo: string | null | undefined, suffix: "号室" | "号" = "号室"): string | null {
  const r = (roomNo ?? "").trim();
  if (!r) return null;
  return /号室?$/.test(r) ? r : `${r}${suffix}`;
}
