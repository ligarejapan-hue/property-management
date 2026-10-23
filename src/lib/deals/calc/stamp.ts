export interface Brackets { brackets: { upTo: number | null; tax: number }[] }

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
