import { yen } from "../../calc/format";
import type { SettlementRow } from "../../calc/settlement";
import { html, type SafeHtml } from "../html";
import { companyBlock, documentHtml } from "../layout";
import { DASH, dateJa, dateTimeJa, headTable, money, namesOf, partiesOf, propertyLabel, type BusinessDocContext, type ValueRow } from "./common";

const cell = (n: number) => (n ? `${yen(n)}円` : "");

/** 精算の行(当てはまらない行は段2の計算が出さない=管理費は区分だけ・賃料と敷金は OC だけ)。敷金の承継は合計に入らないので別に出す。 */
const rowsOf = (c: BusinessDocContext): SettlementRow[] => c.calc.settlement.rows;

/** 預り敷金の承継(OC だけ)。合計の行のあとに出す(合計に入らない・最終レビュー)。 */
function depositLine(c: BusinessDocContext, cols: number): SafeHtml | null {
  const d = c.calc.settlement.depositRow;
  return d ? html`<tr><td colspan="${cols}">${d.label}(${d.note ?? ""}・合計には含みません)</td><td class="num">${cell(d.sellerToBuyer)}</td><td class="num"></td></tr>` : null;
}

function head(c: BusinessDocContext): SafeHtml {
  const d = c.deal;
  return headTable([
    ["物件", propertyLabel(d)],
    ["売買価格", money(d.price)],
    ["決済日時", dateTimeJa(d.settlementAt)],
    ["決済場所", d.settlementPlace],
    ["売主", namesOf(partiesOf(d, "seller"))],
    ["買主", namesOf(partiesOf(d, "buyer"))],
  ]);
}

function totals(c: BusinessDocContext, cols: number): SafeHtml {
  const s = c.calc.settlement;
  return html`<tr class="total"><th colspan="${cols}">合計</th><td class="num">${cell(s.totalSellerToBuyer)}</td><td class="num">${cell(s.totalBuyerToSeller)}</td></tr>`;
}

/** 差引の1行と、残代金との関係(設計 §4.4)。 */
function summary(c: BusinessDocContext): SafeHtml {
  const s = c.calc.settlement;
  return html`<p style="font-size:12pt;font-weight:bold;margin:4mm 0 2mm">差引: ${s.netLine}</p>
${s.paymentAtSettlement !== null ? html`<p>残代金 ${money(s.remaining)} ${s.net.direction === "sellerToBuyer" ? "−" : "+"} 精算金 ${money(s.net.amount)}${s.depositOffset ? html` − 敷金の承継 ${money(s.depositOffset)}` : null} = <b>決済時のお支払額 ${money(s.paymentAtSettlement)}</b></p>` : null}
${s.warnings.length ? html`<ul class="notes">${s.warnings.map((w) => html`<li>${w}</li>`)}</ul>` : null}`;
}

/** 計算の過程を入れた1枚の形。 */
function fullTable(c: BusinessDocContext): SafeHtml {
  return html`<table>
<tr><th>項目</th><th>計算期間</th><th>計算式</th><th class="num">売主→買主</th><th class="num">買主→売主</th></tr>
${rowsOf(c).map((r) => html`<tr><td>${r.label}${r.note ? html`(${r.note})` : null}</td><td>${r.period ?? ""}</td><td>${r.formula ?? ""}</td><td class="num">${cell(r.sellerToBuyer)}</td><td class="num">${cell(r.buyerToSeller)}</td></tr>`)}
${totals(c, 3)}
${depositLine(c, 3)}
</table>`;
}

/** 1枚目(項目と金額と合計だけ)+2枚目「計算明細」。 */
function compactTables(c: BusinessDocContext): { first: SafeHtml; detail: SafeHtml } {
  const rows = rowsOf(c);
  return {
    first: html`<table>
<tr><th>項目</th><th class="num">売主→買主</th><th class="num">買主→売主</th></tr>
${rows.map((r) => html`<tr><td>${r.label}${r.note ? html`(${r.note})` : null}</td><td class="num">${cell(r.sellerToBuyer)}</td><td class="num">${cell(r.buyerToSeller)}</td></tr>`)}
${totals(c, 1)}
${depositLine(c, 1)}
</table>
<p class="notes">計算の過程は2枚目の「計算明細」をご覧ください。</p>`,
    detail: html`<div style="page-break-before:always"><h1>計算明細</h1><table>
<tr><th>項目</th><th>計算期間</th><th>計算式</th></tr>
${rows.map((r) => html`<tr><td>${r.label}</td><td>${r.period ?? DASH}</td><td>${r.formula ?? DASH}</td></tr>`)}
</table></div>`,
  };
}

/**
 * 精算書(決済で1枚にまとめる・依頼書 4.4・計画の読み替え 6)。html=計算の過程入りの1枚の形、compactHtml=2枚目に回した形。
 * 発行の道が html で PDF を作ってページ数を数え、2ページ以上なら compactHtml で作り直す。
 */
export function buildSettlementStatement(c: BusinessDocContext): { html: string; compactHtml: string; rows: ValueRow[] } {
  const title = "精算書";
  const top = html`<h1>${title}</h1><div class="meta"><div></div><div class="right">作成日 ${dateJa(c.today)}</div></div>${head(c)}<h2>精算項目</h2>`;
  const tail = companyBlock(c.company, c.logo);
  const compact = compactTables(c);
  const s = c.calc.settlement;
  const rows: ValueRow[] = [
    { label: "物件", value: propertyLabel(c.deal) }, { label: "売買価格", value: c.deal.price },
    { label: "決済日時", value: dateTimeJa(c.deal.settlementAt) }, { label: "精算項目", heading: true },
    // 両方に金額がある行(自由行)は、向きごとに1行ずつ(最終レビュー)。
    ...rowsOf(c).flatMap((r) => [
      ...(r.sellerToBuyer ? [{ label: `${r.label}(売主→買主)`, value: r.sellerToBuyer }] : []),
      ...(r.buyerToSeller || !r.sellerToBuyer ? [{ label: `${r.label}(買主→売主)`, value: r.buyerToSeller }] : []),
    ]),
    { label: "合計(売主→買主)", value: s.totalSellerToBuyer }, { label: "合計(買主→売主)", value: s.totalBuyerToSeller },
    ...(s.depositRow ? [{ label: `${s.depositRow.label}(${s.depositRow.note ?? ""}・合計には含まない)`, value: s.depositRow.sellerToBuyer }] : []),
    { label: "差引", value: s.netLine }, { label: "決済時のお支払額", value: s.paymentAtSettlement },
  ];
  return {
    html: documentHtml({ title, body: html`${top}${fullTable(c)}${summary(c)}${tail}` }),
    compactHtml: documentHtml({ title, body: html`${top}${compact.first}${summary(c)}${tail}${compact.detail}` }),
    rows,
  };
}
