export interface Brackets { brackets: { upTo: number | null; tax: number }[] }

/**
 * 不動産の譲渡に関する契約書の印紙税の軽減措置の終わり(租税特別措置法91条)。
 * 2026-11-04 国税庁「不動産売買契約書の印紙税の軽減措置」で、2027-03-31 までに作成分のままと確認。
 * 延長が決まったら、料率表(stamp_contract)の期間と合わせてここも直す。
 */
export const STAMP_CONTRACT_REDUCTION_END = "2027-03-31";

/** 金額・費用タブの印紙税の横の説明(基準日=契約日→決済日→今日)。 */
export function stampNote(baseDate: string): string {
  return baseDate <= STAMP_CONTRACT_REDUCTION_END
    ? "軽減措置の税率(2027年3月31日までに作る契約書)"
    : "本則の税率(軽減措置は2027年3月31日まで)";
}

/** 金額の区分で税額を引く(upTo は「その金額以下」・null は上限なし)。 */
export function stampTax(amount: number, table: Brackets): number {
  const hit = table.brackets.find((b) => b.upTo === null || amount <= b.upTo);
  return hit ? hit.tax : 0;
}

/** 売買契約書の印紙税。折半は ÷2 の円未満切り捨て(依頼書 3.5)。 */
export function contractStamp(amount: number, table: Brackets, share: "full" | "half"): number {
  const tax = stampTax(amount, table);
  return share === "half" ? Math.floor(tax / 2) : tax;
}

/** 領収書の非課税(個人が事業用でない物件を売る場合)。初期値は「判断が必要」=出力前に確認を求める。 */
export type ReceiptExempt = "yes" | "no" | "unknown";

export function receiptStamp(amount: number, table: Brackets, exempt: ReceiptExempt): { tax: number; needsDecision: boolean } {
  if (exempt === "yes") return { tax: 0, needsDecision: false };
  return { tax: stampTax(amount, table), needsDecision: exempt === "unknown" };
}
