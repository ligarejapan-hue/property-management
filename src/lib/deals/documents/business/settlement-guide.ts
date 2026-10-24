import { z } from "zod";
import { text } from "../../schema-parts";
import { BANK_ACCOUNT_TYPE_LABELS } from "../../constants";
import { html } from "../html";
import { companyBlock, documentHtml } from "../layout";
import { dateJa, dateTimeJa, headTable, money, namesOf, partiesOf, propertyLabel, type BusinessDocContext, type ValueRow } from "./common";

/** 発行のときに選ぶもの(計画の読み替え 2・7)。 */
export const settlementGuideOptionsSchema = z.object({ payee: text(300), belongings: text(500) }).strict();
export type SettlementGuideOptions = z.output<typeof settlementGuideOptionsSchema>;

/** 持ち物の初期値(どの会社でも使える一般的なもの)。 */
export const DEFAULT_BELONGINGS = ["ご本人確認書類(運転免許証など)", "ご印鑑(登記にお使いのもの)", "住民票(登記に必要な場合)", "通帳・お届け印(お振込みの場合)"].join("\n");

/** 振込先の初期値: 売主が自社なら取引の設定の口座、それ以外は空(計画の読み替え 7)。 */
export function defaultPayee(c: BusinessDocContext): string | null {
  const selfSeller = partiesOf(c.deal, "seller").some((p) => p.isSelf);
  const b = c.settings.bankAccount;
  if (!selfSeller || !b.bankName) return null;
  return [b.bankName, b.branchName, b.accountType ? BANK_ACCOUNT_TYPE_LABELS[b.accountType] : null, b.accountNumber, b.accountHolder && `名義 ${b.accountHolder}`]
    .filter(Boolean).join(" ");
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
