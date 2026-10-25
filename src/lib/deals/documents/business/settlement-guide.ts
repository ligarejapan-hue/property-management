import { z } from "zod";
import { text, yenInt } from "../../schema-parts";
import { html } from "../html";
import { companyBlock, documentHtml } from "../layout";
import { bankAccountText, dateJa, dateTimeJa, headTable, money, namesOf, partiesOf, propertyLabel, type BusinessDocContext, type ValueRow } from "./common";

/** 発行のときに選ぶもの(計画の読み替え 2・7)。 */
export const settlementGuideOptionsSchema = z.object({ payee: text(300), belongings: text(500) }).strict();
export type SettlementGuideOptions = z.output<typeof settlementGuideOptionsSchema>;

/** 持ち物の初期値(どの会社でも使える一般的なもの)。 */
export const DEFAULT_BELONGINGS = ["ご本人確認書類(運転免許証など)", "ご印鑑(登記にお使いのもの)", "住民票(登記に必要な場合)", "通帳・お届け印(お振込みの場合)"].join("\n");

/** 振込先の初期値: 売主が自社なら取引の設定の口座、それ以外は空(計画の読み替え 7)。 */
export function defaultPayee(c: BusinessDocContext): string | null {
  return partiesOf(c.deal, "seller").some((p) => p.isSelf) ? bankAccountText(c) : null;
}

/**
 * 残金決済のご案内(依頼書 4.3)。宛先は買主。金種明細は精算書と同じ「残代金+精算金−敷金承継=決済時のお支払額」(計画の読み替え 7)。
 */
export function buildSettlementGuide(c: BusinessDocContext, o: SettlementGuideOptions): { html: string; rows: ValueRow[] } {
  const s = c.calc.settlement;
  const d = c.deal;
  const buyer = namesOf(partiesOf(d, "buyer"));
  const netSigned = s.net.direction === "sellerToBuyer" ? -s.net.amount : s.net.amount;
  const title = "残金決済のご案内";
  const body = html`
<h1>${title}</h1>
<div class="meta"><div class="customer">${buyer ?? ""} 様</div><div class="right">${dateJa(c.today)}</div></div>
<p>このたびはお取引をいただき、ありがとうございます。残金のお支払い(決済)について、次のとおりご案内いたします。</p>
${headTable([["物件", propertyLabel(d)], ["決済日時", dateTimeJa(d.settlementAt)], ["決済場所", d.settlementPlace]])}
<h2>当日お支払いいただく金額</h2>
<table>
<tr><th style="width:60%">残代金(売買価格−手付金)</th><td class="num">${money(s.remaining)}</td></tr>
<tr><th>精算金(${s.net.direction === "sellerToBuyer" ? "売主からお受け取り" : "固都税・管理費など"})</th><td class="num">${money(netSigned)}</td></tr>
${s.depositOffset ? html`<tr><th>預り敷金の承継(残代金と相殺)</th><td class="num">${money(-s.depositOffset)}</td></tr>` : null}
<tr class="total"><th>決済時のお支払額</th><td class="num">${money(s.paymentAtSettlement)}</td></tr>
</table>
<ul class="notes"><li>精算金の内訳は「精算書」のとおりです。</li><li>登記費用などは、別途、司法書士へお支払いください。</li></ul>
<h2>お振込先</h2>
<p class="remarks">${o.payee ?? "(当日までにご案内いたします)"}</p>
<h2>お持ちいただくもの</h2>
<p class="remarks">${o.belongings ?? ""}</p>
${companyBlock(c.company, c.logo)}`;
  return {
    html: documentHtml({ title, font: "mincho", body }),
    rows: [
      { label: "宛先", value: buyer }, { label: "物件", value: propertyLabel(d) }, { label: "決済日時", value: dateTimeJa(d.settlementAt) },
      { label: "決済場所", value: d.settlementPlace }, { label: "残代金", value: s.remaining }, { label: "精算金", value: netSigned },
      { label: "預り敷金の承継(相殺)", value: s.depositOffset ? -s.depositOffset : null }, { label: "決済時のお支払額", value: s.paymentAtSettlement },
      { label: "お振込先", value: o.payee }, { label: "お持ちいただくもの", value: o.belongings },
    ],
  };
}

// ---- 売主様あて(依頼書 4.3 の「残代金+精算金−諸費用」・10-25 発注者の決定)----

const sellerCostSchema = z.object({ label: z.string().trim().min(1, "諸費用の項目名が空の行があります").max(50), amount: yenInt }).strict();
export const sellerGuideOptionsSchema = z.object({
  /** お受取額から差し引く諸費用(初期値は取引の費用・発行のときに直す)。 */
  costs: z.array(sellerCostSchema).max(20),
  /** お受け取りの口座(空なら「当日までにお知らせください」)。 */
  receiveTo: text(300),
  belongings: text(500),
}).strict();
export type SellerGuideOptions = z.output<typeof sellerGuideOptionsSchema>;

export const DEFAULT_SELLER_BELONGINGS = [
  "ご本人確認書類(運転免許証など)", "ご実印・印鑑証明書", "登記識別情報(権利証)", "物件の鍵", "お受け取りの口座の通帳(お振込みの場合)",
].join("\n");

/**
 * 諸費用の初期値: 仲介手数料(売主側・両手の仲介だけ)と、取引の費用の抹消費用・測量費・その他の行。
 * 登記費用(移転など)は買主の費用なので入れない。
 */
export function defaultSellerCosts(c: BusinessDocContext): { label: string; amount: number }[] {
  const d = c.deal;
  const rows: { label: string; amount: number }[] = [];
  if (d.businessType === "brokerage" && (d.tradeSide === "seller" || d.tradeSide === "both") && c.calc.brokerage) {
    rows.push({ label: "仲介手数料(税込)", amount: c.calc.brokerage.incl });
  }
  if (d.costs.cancellationFee) rows.push({ label: "抵当権などの抹消費用", amount: d.costs.cancellationFee });
  if (d.costs.surveyFee) rows.push({ label: "測量費", amount: d.costs.surveyFee });
  for (const o of d.costs.others) rows.push({ label: o.label, amount: o.amount });
  return rows;
}

/** 残金決済のご案内(売主様)。残代金+精算金(−敷金承継)−諸費用=当日のお受取額。 */
export function buildSellerSettlementGuide(c: BusinessDocContext, o: SellerGuideOptions): { html: string; rows: ValueRow[] } {
  const s = c.calc.settlement;
  const d = c.deal;
  const seller = namesOf(partiesOf(d, "seller"));
  const netSigned = s.net.direction === "sellerToBuyer" ? -s.net.amount : s.net.amount;
  const costTotal = o.costs.reduce((a, r) => a + r.amount, 0);
  const receive = s.paymentAtSettlement === null ? null : s.paymentAtSettlement - costTotal;
  const title = "残金決済のご案内";
  const body = html`
<h1>${title}</h1>
<div class="meta"><div class="customer">${seller ?? ""} 様</div><div class="right">${dateJa(c.today)}</div></div>
<p>このたびはお取引をいただき、ありがとうございます。残代金のお受け取り(決済)について、次のとおりご案内いたします。</p>
${headTable([["物件", propertyLabel(d)], ["決済日時", dateTimeJa(d.settlementAt)], ["決済場所", d.settlementPlace]])}
<h2>当日お受け取りいただく金額</h2>
<table>
<tr><th style="width:60%">残代金(売買価格−手付金)</th><td class="num">${money(s.remaining)}</td></tr>
<tr><th>精算金(${s.net.direction === "sellerToBuyer" ? "買主へお支払い" : "固都税・管理費など"})</th><td class="num">${money(netSigned)}</td></tr>
${s.depositOffset ? html`<tr><th>預り敷金の承継(残代金と相殺)</th><td class="num">${money(-s.depositOffset)}</td></tr>` : null}
<tr><th>諸費用(下の内訳)</th><td class="num">${money(-costTotal)}</td></tr>
<tr class="total"><th>当日のお受取額</th><td class="num">${money(receive)}</td></tr>
</table>
${o.costs.length ? html`<h2>諸費用の内訳</h2>
<table>${o.costs.map((r) => html`<tr><th style="width:60%">${r.label}</th><td class="num">${money(r.amount)}</td></tr>`)}
<tr class="total"><th>合計</th><td class="num">${money(costTotal)}</td></tr></table>` : null}
<ul class="notes"><li>精算金の内訳は「精算書」のとおりです。</li><li>諸費用は、お受け取りの代金から差し引いてお支払いいただく想定の金額です。</li></ul>
<h2>お受け取りの口座</h2>
<p class="remarks">${o.receiveTo ?? "(当日までにお知らせください)"}</p>
<h2>お持ちいただくもの</h2>
<p class="remarks">${o.belongings ?? ""}</p>
${companyBlock(c.company, c.logo)}`;
  return {
    html: documentHtml({ title, font: "mincho", body }),
    rows: [
      { label: "宛先", value: seller }, { label: "物件", value: propertyLabel(d) }, { label: "決済日時", value: dateTimeJa(d.settlementAt) },
      { label: "決済場所", value: d.settlementPlace }, { label: "残代金", value: s.remaining }, { label: "精算金", value: netSigned },
      { label: "預り敷金の承継(相殺)", value: s.depositOffset ? -s.depositOffset : null },
      { label: "諸費用", heading: true }, ...o.costs.map((r) => ({ label: r.label, value: r.amount })),
      { label: "諸費用の合計", value: costTotal }, { label: "当日のお受取額", value: receive },
      { label: "お受け取りの口座", value: o.receiveTo }, { label: "お持ちいただくもの", value: o.belongings },
    ],
  };
}
